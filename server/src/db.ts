import pg from "pg";
import { Connector, AuthTypes, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { config } from "./config.js";

// numeric -> number og date -> "ÅÅÅÅ-MM-DD" (ikke Date, så tidssoner aldri flytter en dato).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

let pool: pg.Pool | undefined;

async function lagPool(): Promise<pg.Pool> {
  if (config.dbInstans) {
    const connector = new Connector();
    const opts = await connector.getOptions({
      instanceConnectionName: config.dbInstans,
      ipType: IpAddressTypes.PRIVATE,
      authType: AuthTypes.IAM,
    });
    return new pg.Pool({ ...opts, user: config.dbBruker, database: config.dbNavn, max: 10 });
  }
  if (!config.databaseUrl) throw new Error("DB_INSTANCE eller DATABASE_URL må være satt");
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
}

export async function hentPool(): Promise<pg.Pool> {
  pool ??= await lagPool();
  return pool;
}

export type Db = pg.PoolClient;

// Kjører fn i én transaksjon med app.bruker_id satt, slik at RLS og faktura.kan() virker.
export async function somBruker<T>(brukerId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return transaksjon(fn, brukerId);
}

// Workeren: ingen bruker; tilgangen kommer fra rollen faktura_system.
export async function somSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return transaksjon(fn);
}

async function transaksjon<T>(fn: (db: Db) => Promise<T>, brukerId?: string): Promise<T> {
  const p = await hentPool();
  const db = await p.connect();
  try {
    await db.query("begin");
    if (brukerId) await db.query("select set_config('app.bruker_id', $1, true)", [brukerId]);
    const svar = await fn(db);
    await db.query("commit");
    return svar;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

export async function en<T = any>(db: Db, sql: string, verdier: unknown[] = []): Promise<T | undefined> {
  const r = await db.query(sql, verdier);
  return r.rows[0] as T | undefined;
}

export async function alle<T = any>(db: Db, sql: string, verdier: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, verdier);
  return r.rows as T[];
}
