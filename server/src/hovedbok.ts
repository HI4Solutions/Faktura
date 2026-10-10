// Hovedboken (0087_regnskap_bilag.sql): bilagene fra alle kildene (fakturaer og innbetalinger, lønn,
// refusjoner fra NAV, anleggsmidler, periodiseringer og manuelle bilag) med posteringene,
// saldobalansen og hovedboken per konto for en periode. Balansekontoene (klasse 1 og 2) har saldo fra
// starten; resultatkontoene (klasse 3–8) begynner på null hvert år, og resultatet fra tidligere år
// som ikke er ført mot egenkapitalen, står på en egen linje (så saldobalansen går i null). Fakturaene
// og innbetalingene som ikke er bokført ennå, bokføres først (salgBokforing.ts).
import { alle, type Db } from "./db.js";
import { hentRegnskapsoppsett, REGNSKAPSKONTOER, regnskapskontoer } from "./anlegg.js";
import { kontonavnFor } from "./kontoplan.js";
import { bokforSalgNaa } from "./salgBokforing.js";

export const KILDER: Record<string, string> = {
  faktura: "Faktura",
  innbetaling: "Innbetaling",
  utgift: "Utgift",
  utgift_betaling: "Betaling av utgift",
  bank: "Bankpost",
  mva: "Mva-oppgjør",
  mva_justering: "Mva-justering",
  aarsoppgjor: "Årsoppgjør",
  lonn: "Lønn",
  nav_refusjon: "Refusjon fra NAV",
  anlegg: "Anleggsmidler",
  periodisering: "Periodisering",
  manuell: "Manuelt bilag",
};
export type Regnskapsbilag = {
  id: string;
  bilagsnummer: string;
  serie: string;
  dato: string;
  tekst: string;
  kilde: string;
  reverserer: string | null;
  reversert_av: string | null;
  opprettet_av: string | null;
  // Det bilaget kommer fra i appen (fakturaen, også for en innbetaling, eller lønnskjøringen).
  lenke: string | null;
  // mva_kode: bare der det er en (fakturaene og innbetalingene).
  posteringer: { konto: string; navn: string; tekst: string; belop: number; mva_kode?: string }[];
};
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const balansekonto = (konto: string) => konto.startsWith("1") || konto.startsWith("2");

export async function navnPaaKonto(db: Db, org: string) {
  const plan = regnskapskontoer(await hentRegnskapsoppsett(db, org));
  return kontonavnFor(
    db,
    org,
    REGNSKAPSKONTOER.map((k) => ({ rolle: k.rolle, navn: k.navn, konto: plan[k.rolle] })),
  );
}

// Bilagene i perioden (eller ett bilag), i rekkefølgen dato, serie og nummer.
export async function hentRegnskapsbilag(db: Db, org: string, v: { fra?: string; til?: string; kilde?: string | null; id?: string }) {
  if (!v.id) await bokforSalgNaa(db, org);
  const navn = await navnPaaKonto(db, org);
  const bilag = await alle<Omit<Regnskapsbilag, "posteringer">>(
    db,
    `select b.id, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer, b.serie, to_char(b.dato, 'YYYY-MM-DD') as dato, b.tekst, b.kilde,
            b.reverserer, b.reversert_av, (select coalesce(u.navn, u.epost) from faktura.brukere u where u.id = b.opprettet_av) as opprettet_av,
            case b.kilde
              when 'faktura' then (select '/fakturaer/' || f.id from faktura.fakturaer f where f.id = b.kilde_id)
              when 'innbetaling' then (select '/fakturaer/' || p.faktura_id from faktura.betalinger p where p.id = b.kilde_id)
              when 'utgift' then '/regnskap?fane=utgifter&utgift=' || b.kilde_id
              when 'utgift_betaling' then '/regnskap?fane=utgifter&utgift=' || b.kilde_id
              when 'bank' then '/regnskap?fane=bank&post=' || b.kilde_id
              when 'mva' then (select '/regnskap?fane=mva&aar=' || t.aar || '&termin=' || t.termin from faktura.mva_terminer t where t.id = b.kilde_id)
              when 'aarsoppgjor' then (select '/regnskap?fane=aarsoppgjor&aar=' || a.aar from faktura.aarsoppgjor a where a.id = b.kilde_id)
              when 'mva_justering' then coalesce(
                (select '/regnskap?fane=mva&aar=' || j.aar || '&termin='
                        || case (select o.mva_termin from faktura.regnskap_oppsett o where o.org_id = b.org_id) when 'maaned' then 12 when 'aar' then 1 else 6 end
                   from faktura.mva_justeringer j where j.id = b.kilde_id),
                '/regnskap?fane=anlegg&anlegg=' || b.kilde_id)
              when 'lonn' then '/lonn?kjoring=' || b.kilde_id
            end as lenke
       from faktura.bilag b
      where b.org_id = $1 and ($2::uuid is null or b.id = $2) and ($3::date is null or b.dato >= $3) and ($4::date is null or b.dato <= $4)
        and ($5::text is null or b.kilde = $5)
      order by b.dato, b.serie, b.aar, b.nummer`,
    [org, v.id ?? null, v.fra ?? null, v.til ?? null, v.kilde ?? null],
  );
  if (!bilag.length) return [];
  const poster = await alle<{ bilag_id: string; konto: string; tekst: string | null; belop: number; mva_kode: string | null }>(
    db,
    "select bilag_id, konto, tekst, belop::float8 as belop, mva_kode from faktura.posteringer where org_id = $1 and bilag_id = any($2::uuid[]) order by bilag_id, rekke",
    [org, bilag.map((b) => b.id)],
  );
  const per = new Map<string, Regnskapsbilag["posteringer"]>();
  for (const p of poster)
    per.set(p.bilag_id, [
      ...(per.get(p.bilag_id) ?? []),
      { konto: p.konto, navn: navn(p.konto), tekst: p.tekst ?? "", belop: p.belop, ...(p.mva_kode ? { mva_kode: p.mva_kode } : {}) },
    ]);
  return bilag.map((b) => ({ ...b, posteringer: per.get(b.id) ?? [] }));
}

export type Saldorad = { konto: string; navn: string; inngaende: number; debet: number; kredit: number; utgaende: number };

// Saldobalansen for perioden: inngående saldo, bevegelsene og utgående saldo per konto.
export async function saldobalanse(db: Db, org: string, fra: string, til: string) {
  await bokforSalgNaa(db, org);
  const navn = await navnPaaKonto(db, org);
  const rader = await alle<{ konto: string; inngaende: number; debet: number; kredit: number; tidligere: number }>(
    db,
    `select p.konto,
            coalesce(sum(p.belop) filter (where b.dato < $2::date and (left(p.konto, 1) in ('1', '2') or b.dato >= date_trunc('year', $2::date))), 0)::float8 as inngaende,
            coalesce(sum(p.belop) filter (where b.dato >= $2::date and p.belop > 0), 0)::float8 as debet,
            coalesce(-sum(p.belop) filter (where b.dato >= $2::date and p.belop < 0), 0)::float8 as kredit,
            coalesce(sum(p.belop) filter (where left(p.konto, 1) not in ('1', '2') and b.dato < date_trunc('year', $2::date)), 0)::float8 as tidligere
       from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id
      where b.org_id = $1 and b.dato <= $3::date
      group by p.konto order by p.konto`,
    [org, fra, til],
  );
  const ut: Saldorad[] = rader
    .map((r) => ({ konto: r.konto, navn: navn(r.konto), inngaende: rund(r.inngaende), debet: rund(r.debet), kredit: rund(r.kredit), utgaende: rund(r.inngaende + r.debet - r.kredit) }))
    .filter((r) => r.inngaende || r.debet || r.kredit || r.utgaende);
  const tidligere = rund(rader.reduce((s, r) => s + r.tidligere, 0));
  // Resultatet i perioden (inntekt minus kostnad: kreditsaldoen på resultatkontoene).
  const resultat = rund(-ut.filter((r) => !balansekonto(r.konto)).reduce((s, r) => s + r.debet - r.kredit, 0));
  return { fra, til, rader: ut, tidligere, resultat };
}

export type Hovedbokspost = { dato: string; bilag: string; bilag_id: string; bilagstekst: string; tekst: string; debet: number | null; kredit: number | null; saldo: number };

// Hovedboken: for hver konto med saldo eller bevegelser, inngående saldo og posteringene med saldo.
export async function hovedbok(db: Db, org: string, fra: string, til: string, konto?: string | null) {
  const s = await saldobalanse(db, org, fra, til);
  const kontoer = s.rader.filter((r) => !konto || r.konto === konto);
  if (!kontoer.length) return [];
  const poster = await alle<{ konto: string; dato: string; bilag: string; bilag_id: string; bilagstekst: string; tekst: string | null; belop: number }>(
    db,
    `select p.konto, to_char(b.dato, 'YYYY-MM-DD') as dato, b.serie || '-' || b.aar || '-' || b.nummer as bilag, b.id as bilag_id, b.tekst as bilagstekst,
            p.tekst, p.belop::float8 as belop
       from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id
      where b.org_id = $1 and b.dato between $2::date and $3::date and p.konto = any($4::text[])
      order by p.konto, b.dato, b.serie, b.aar, b.nummer, p.rekke`,
    [org, fra, til, kontoer.map((k) => k.konto)],
  );
  return kontoer.map((k) => {
    let saldo = k.inngaende;
    return {
      ...k,
      poster: poster
        .filter((p) => p.konto === k.konto)
        .map((p): Hovedbokspost => {
          saldo = rund(saldo + p.belop);
          return { dato: p.dato, bilag: p.bilag, bilag_id: p.bilag_id, bilagstekst: p.bilagstekst, tekst: p.tekst ?? "", debet: p.belop > 0 ? p.belop : null, kredit: p.belop < 0 ? -p.belop : null, saldo };
        }),
    };
  });
}
