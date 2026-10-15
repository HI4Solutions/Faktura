// Feilene fra Altinn (altinnFeil) og statusene på forespørslene (tilStatus). Altinn svarer på flere
// måter: ProblemDetails med kode, valideringsfeilene fra ASP.NET (errors), eller bare en tekst
// (BadRequest("…"), f.eks. når correlation-id mangler på endringsforespørselen).
import { describe, expect, it } from "vitest";
import { altinnFeil, tilStatus } from "../src/altinn.js";

const feil = (status: number, tekst: string) => {
  let data: any = null;
  try {
    data = JSON.parse(tekst);
  } catch {}
  return altinnFeil({ status, data, tekst }, "Kunne ikke lage endringsforespørselen i Altinn");
};

describe("feilene fra Altinn", () => {
  it("tar med meldingen, uansett hvordan Altinn svarer", () => {
    const f = feil(400, JSON.stringify({ title: "Bad Request", status: 400, detail: "The Id does not refer to a Registered System.", code: "AUTH-00011" }));
    expect(f.message).toBe("Kunne ikke lage endringsforespørselen i Altinn: The Id does not refer to a Registered System. (AUTH-00011)");
    expect([f.status, f.kode]).toEqual([400, "AUTH-00011"]);
    expect(feil(400, "Missing or invalid QueryParameter: correlation-id. Generate a unique UUID (RFC 4122) for this Change Request.").message).toBe(
      "Kunne ikke lage endringsforespørselen i Altinn: Missing or invalid QueryParameter: correlation-id. Generate a unique UUID (RFC 4122) for this Change Request.",
    );
    expect(
      feil(400, JSON.stringify({ title: "One or more validation errors occurred.", status: 400, errors: { "$.requiredAccessPackages": ["The field is required."] } })).message,
    ).toBe("Kunne ikke lage endringsforespørselen i Altinn: The field is required.");
    expect(
      feil(400, JSON.stringify({ title: "Bad Request", validationErrors: [{ code: "AUTH.VLD-00002", detail: "The access package is not on the system." }] })).message,
    ).toBe("Kunne ikke lage endringsforespørselen i Altinn: The access package is not on the system. (AUTH.VLD-00002)");
    expect(feil(400, "").message).toBe("Kunne ikke lage endringsforespørselen i Altinn: Altinn svarte 400");
  });

  it("en endringsforespørsel systembrukeren ikke trenger, er godkjent", () => {
    expect(["New", "Accepted", "Rejected", "Denied", "Timedout", "NoChangeNeeded"].map(tilStatus)).toEqual(["ny", "godkjent", "avslatt", "avvist", "utlopt", "godkjent"]);
  });
});
