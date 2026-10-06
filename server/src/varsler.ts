// Hva som gir push-varsel, og hva varselet sier. Kjøres av workeren.
import { alle, en, somSystem } from "./db.js";
import { forsteGang, sendVarsel } from "./push.js";
import { dato, kr } from "./regler.js";

const flertall = (n: number, entall: string, flere: string) => (n === 1 ? entall : flere);

// Hendelser fra utboksen (Pub/Sub-abonnementet «hendelser-varsler»).
export async function varsleOmHendelse(hendelse: string | undefined, orgId: string | undefined, utboksId: string | undefined, data: any) {
  if (!hendelse || !orgId || !utboksId) return;

  if (hendelse === "faktura.betalt" && data?.type === "faktura" && data.faktura_id) {
    if (!(await forsteGang(`utboks:${utboksId}`))) return;
    const f = await somSystem((db) =>
      en(
        db,
        `select f.id, f.fakturanummer, f.sum_inkl_mva, coalesce(f.kunde ->> 'navn', k.navn) as kunde,
                (select b.registrert_av from faktura.betalinger b where b.faktura_id = f.id order by b.opprettet desc limit 1) as registrert_av
           from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
          where f.id = $1 and f.status = 'betalt'`,
        [data.faktura_id],
      ),
    );
    if (!f) return;
    await sendVarsel({
      hendelse: "betaling",
      org_id: orgId,
      unntatt: f.registrert_av ?? undefined, // den som registrerte betalingen, vet det allerede
      tittel: "Betaling mottatt",
      tekst: `${f.kunde} har betalt faktura ${f.fakturanummer} på ${kr(f.sum_inkl_mva)} kr.`,
      url: `/fakturaer/${f.id}`,
      tag: `faktura-${f.id}`,
    });
    return;
  }

  if ((hendelse === "epost.sprett" || hendelse === "epost.klage") && data?.faktura_id) {
    if (!(await forsteGang(`utboks:${utboksId}`))) return;
    const f = await somSystem((db) =>
      en(
        db,
        `select f.id, f.type, f.fakturanummer, coalesce(f.kunde ->> 'navn', k.navn) as kunde
           from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id where f.id = $1`,
        [data.faktura_id],
      ),
    );
    if (!f) return;
    const hva = `${f.type === "kreditnota" ? "Kreditnota" : "Faktura"} ${f.fakturanummer ?? ""}`.trim();
    await sendVarsel({
      hendelse: "epostfeil",
      org_id: orgId,
      tittel: hendelse === "epost.sprett" ? "E-post kom ikke fram" : "E-post merket som søppelpost",
      tekst:
        hendelse === "epost.sprett"
          ? `${hva} til ${f.kunde} kunne ikke leveres til ${data.til ?? "mottakeren"}. Sjekk e-postadressen og send på nytt.`
          : `${f.kunde} merket e-posten med ${hva.toLowerCase()} som søppelpost.`,
      url: `/fakturaer/${f.id}`,
      tag: `epost-${f.id}`,
    });
  }
}

// Daglig: fakturaer som forfalt i går, ett varsel per organisasjon.
export async function varsleForfalte() {
  const grupper = await somSystem((db) =>
    alle(
      db,
      `select f.org_id, faktura.i_dag()::text as dag, count(*)::int as antall,
              sum(f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop) as belop,
              (array_agg(f.id order by f.fakturanummer))[1] as forste_id,
              (array_agg(f.fakturanummer order by f.fakturanummer))[1] as forste_nr,
              (array_agg(coalesce(f.kunde ->> 'navn', '') order by f.fakturanummer))[1] as forste_kunde
         from faktura.fakturaer f
        where f.type = 'faktura' and f.status = 'utstedt' and f.forfallsdato = faktura.i_dag() - 1
        group by f.org_id`,
    ),
  );
  for (const g of grupper) {
    try {
      if (!(await forsteGang(`forfalt:${g.org_id}:${g.dag}`))) continue;
      await sendVarsel({
        hendelse: "forfalt",
        org_id: g.org_id,
        tittel: g.antall === 1 ? "Faktura har forfalt" : `${g.antall} fakturaer har forfalt`,
        tekst:
          g.antall === 1
            ? `Faktura ${g.forste_nr} til ${g.forste_kunde} (${kr(g.belop)} kr) forfalt i går uten å være betalt.`
            : `${g.antall} fakturaer på til sammen ${kr(g.belop)} kr forfalt i går uten å være betalt.`,
        url: g.antall === 1 ? `/fakturaer/${g.forste_id}` : "/fakturaer?status=utstedt",
        tag: `forfalt-${g.dag}`,
      });
    } catch (e) {
      console.error(JSON.stringify({ severity: "ERROR", message: "Varsel om forfalte fakturaer feilet", org: g.org_id, feil: (e as Error).message }));
    }
  }
}

// Etter at den daglige jobben har sendt gjentakende fakturaer.
export async function varsleGjentakende(fakturaIder: string[]) {
  if (!fakturaIder.length) return;
  const grupper = await somSystem((db) =>
    alle(
      db,
      `select f.org_id, count(*)::int as antall, sum(f.sum_inkl_mva) as belop,
              (array_agg(f.id order by f.fakturanummer))[1] as forste_id,
              (array_agg(f.fakturanummer order by f.fakturanummer))[1] as forste_nr,
              (array_agg(coalesce(f.kunde ->> 'navn', '') order by f.fakturanummer))[1] as forste_kunde
         from faktura.fakturaer f where f.id = any($1) group by f.org_id`,
      [fakturaIder],
    ),
  );
  for (const g of grupper) {
    try {
      await sendVarsel({
        hendelse: "gjentakende",
        org_id: g.org_id,
        tittel: g.antall === 1 ? "Gjentakende faktura sendt" : `${g.antall} gjentakende fakturaer sendt`,
        tekst:
          g.antall === 1
            ? `Faktura ${g.forste_nr} til ${g.forste_kunde} på ${kr(g.belop)} kr er sendt automatisk.`
            : `${g.antall} ${flertall(g.antall, "faktura", "fakturaer")} på til sammen ${kr(g.belop)} kr er sendt automatisk.`,
        url: g.antall === 1 ? `/fakturaer/${g.forste_id}` : "/fakturaer",
      });
    } catch (e) {
      console.error(JSON.stringify({ severity: "ERROR", message: "Varsel om gjentakende fakturaer feilet", org: g.org_id, feil: (e as Error).message }));
    }
  }
}

// Når en indeksregulering er planlagt.
export async function varsleIndeksregulering(r: any, kunderVarslet: number) {
  const p = await somSystem((db) => en(db, "select navn from faktura.produkter where id = $1", [r.produkt_id]));
  if (!p) return;
  const prosent = ((Number(r.faktor) - 1) * 100).toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  await sendVarsel({
    hendelse: "indeksregulering",
    org_id: r.org_id,
    tittel: "Indeksregulering planlagt",
    tekst:
      `${p.navn} får ny pris fra ${dato(r.gjelder_fra)}: ${kr(Number(r.gammel_pris))} → ${kr(Number(r.ny_pris))} kr (+${prosent} %).` +
      (kunderVarslet ? ` ${kunderVarslet} ${flertall(kunderVarslet, "kunde", "kunder")} har fått varsel.` : ""),
    url: "/produkter",
    tag: `indeks-${r.id}`,
  });
}
