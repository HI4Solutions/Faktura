// Betalingsfila for lønnen (0076_lonn_betalingsfil.sql): ISO 20022 pain.001 (betalingsoppdrag fra
// kunde), som lastes opp og godkjennes i nettbanken. Én betaling (PmtInf) med alle de ansatte:
// lønn (CtgyPurp SALA, så bare dem med lønnstilgang i nettbanken ser beløpene), samlet bokført
// (BtchBookg), på utbetalingsdatoen, fra lønnskontoen. Hver ansatt får nettolønnen til
// kontonummeret sitt (BBAN, 11 siffer), med teksten «Lønn <måned>».
//
// pain.001.001.03 tas imot av alle norske banker (DNB, Nordea, SpareBank 1 …); .09 kan velges.
// Forskjellene: utførelsesdatoen (ReqdExctnDt/Dt) og BIC-elementet (BICFI) i .09. Meldings-ID-en er
// den samme for samme godkjente kjøring, så banken avviser en fil som lastes opp to ganger.

import { createHash } from "node:crypto";

export type Format = "pain.001.001.03" | "pain.001.001.09";
export type Lonnsbetaling = { navn: string; kontonr: string; belop: number; referanse: string };
export type Betalingsfil = {
  format: Format;
  meldingId: string; // høyst 35 tegn, unik per fil
  opprettet: string; // ÅÅÅÅ-MM-DDTtt:mm:ss (norsk tid)
  avsender: { navn: string; orgnr: string | null };
  fraKonto: string; // 11 siffer
  bic: string;
  dato: string; // utbetalingsdatoen, ÅÅÅÅ-MM-DD
  tekst: string; // til mottakerne, høyst 140 tegn
  betalinger: Lonnsbetaling[];
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Teksten uten kontrolltegn og doble mellomrom, kuttet til lengden (før &-kodingen).
const tekst = (s: string, maks: number) =>
  esc(
    [...s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()]
      .slice(0, maks)
      .join("")
      .trim(),
  );
const belop = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const konto = (k: string) => `<Id><Othr><Id>${k}</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id>`;

// Meldings-ID-en for en godkjent kjøring: lik hver gang den lastes ned (banken avviser da en fil
// som lastes opp to ganger), ny når kjøringen godkjennes på nytt.
export function meldingId(periode: string, kjoringId: string, godkjent: string) {
  const h = createHash("sha256").update(`${kjoringId}:${godkjent}`).digest("hex").slice(0, 10).toUpperCase();
  return `LONN-${periode.slice(0, 4)}${periode.slice(5, 7)}-${h}`;
}

export function lagBetalingsfil(f: Betalingsfil): string {
  if (!f.betalinger.length) throw new Error("Betalingsfila må ha minst én betaling");
  const ni = f.format === "pain.001.001.09";
  const antall = f.betalinger.length;
  const sum = belop(f.betalinger.reduce((x, b) => x + Math.round(b.belop * 100), 0) / 100);
  const bic = ni ? `<BICFI>${f.bic}</BICFI>` : `<BIC>${f.bic}</BIC>`;
  const orgId = f.avsender.orgnr ? `<Id><OrgId><Othr><Id>${f.avsender.orgnr}</Id><SchmeNm><Cd>CUST</Cd></SchmeNm></Othr></OrgId></Id>` : "";
  const linjer = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${f.format}">`,
    ` <CstmrCdtTrfInitn>`,
    `  <GrpHdr>`,
    `   <MsgId>${tekst(f.meldingId, 35)}</MsgId>`,
    `   <CreDtTm>${f.opprettet}</CreDtTm>`,
    `   <NbOfTxs>${antall}</NbOfTxs>`,
    `   <CtrlSum>${sum}</CtrlSum>`,
    `   <InitgPty><Nm>${tekst(f.avsender.navn, 140)}</Nm>${orgId}</InitgPty>`,
    `  </GrpHdr>`,
    `  <PmtInf>`,
    `   <PmtInfId>${tekst(`${f.meldingId}-1`, 35)}</PmtInfId>`,
    `   <PmtMtd>TRF</PmtMtd>`,
    `   <BtchBookg>true</BtchBookg>`,
    `   <NbOfTxs>${antall}</NbOfTxs>`,
    `   <CtrlSum>${sum}</CtrlSum>`,
    `   <PmtTpInf><SvcLvl><Cd>NURG</Cd></SvcLvl><CtgyPurp><Cd>SALA</Cd></CtgyPurp></PmtTpInf>`,
    ni ? `   <ReqdExctnDt><Dt>${f.dato}</Dt></ReqdExctnDt>` : `   <ReqdExctnDt>${f.dato}</ReqdExctnDt>`,
    `   <Dbtr><Nm>${tekst(f.avsender.navn, 140)}</Nm></Dbtr>`,
    `   <DbtrAcct>${konto(f.fraKonto)}<Ccy>NOK</Ccy></DbtrAcct>`,
    `   <DbtrAgt><FinInstnId>${bic}</FinInstnId></DbtrAgt>`,
    `   <ChrgBr>SLEV</ChrgBr>`,
    ...f.betalinger.map((b) =>
      [
        `   <CdtTrfTxInf>`,
        `    <PmtId><EndToEndId>${tekst(b.referanse, 35)}</EndToEndId></PmtId>`,
        `    <Amt><InstdAmt Ccy="NOK">${belop(b.belop)}</InstdAmt></Amt>`,
        `    <Cdtr><Nm>${tekst(b.navn, 140)}</Nm></Cdtr>`,
        `    <CdtrAcct>${konto(b.kontonr)}</CdtrAcct>`,
        `    <RmtInf><Ustrd>${tekst(f.tekst, 140)}</Ustrd></RmtInf>`,
        `   </CdtTrfTxInf>`,
      ].join("\n"),
    ),
    `  </PmtInf>`,
    ` </CstmrCdtTrfInitn>`,
    `</Document>`,
  ];
  return `${linjer.join("\n")}\n`;
}
