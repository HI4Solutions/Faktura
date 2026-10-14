-- Noen banker (blant dem Storebrand) sender betalinger som ligger klare i banken (forfallsregisteret,
-- faste betalinger) som ventende kreditt. De ble lagret som reserverte innbetalinger, og kunne holde
-- igjen purringen på en faktura med samme beløp. Hentingen skiller dem nå ut (erReservertInn i
-- server/src/enableBanking.ts). De som er lagret fra før, ryddes her: datert fram i tid, eller betalt
-- fra kontoen selv. Resten erstattes ved neste henting fra banken.
delete from faktura.reserverte_innbetalinger r
 where r.dato > faktura.i_dag()
    or (case
          when regexp_replace(upper(coalesce(r.betaler_konto, '')), '[[:space:].]', '', 'g') ~ '^NO[0-9]{13}$'
            then substr(regexp_replace(upper(r.betaler_konto), '[[:space:].]', '', 'g'), 5)
          else regexp_replace(upper(coalesce(r.betaler_konto, '')), '[[:space:].]', '', 'g')
        end) = r.konto;
