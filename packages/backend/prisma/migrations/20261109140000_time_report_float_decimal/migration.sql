-- Decimal value of the spelling JavaScript's Number toString uses for a float8.
-- PostgreSQL's own float text is a different shortest round-trip, so report
-- costs cannot round that text and still match the per-entry total.

CREATE OR REPLACE FUNCTION public.js_float_bin_cmp(
  binary_sig numeric,
  binary_e2 integer,
  coefficient numeric,
  coefficient_e integer
) RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  left_n numeric := binary_sig;
  right_n numeric := coefficient;
  p2 integer := binary_e2 - coefficient_e;
  p5 integer := -coefficient_e;
BEGIN
  -- binary_sig * 2^binary_e2 ? dec * 10^dec_e, in exact integer arithmetic.
  IF p2 >= 0 THEN
    left_n := left_n * power(2::numeric, p2);
  ELSE
    right_n := right_n * power(2::numeric, -p2);
  END IF;
  IF p5 >= 0 THEN
    left_n := left_n * power(5::numeric, p5);
  ELSE
    right_n := right_n * power(5::numeric, -p5);
  END IF;
  IF left_n < right_n THEN
    RETURN -1;
  ELSIF left_n > right_n THEN
    RETURN 1;
  END IF;
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.js_float_decimal(n float8)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  abs_n float8 := abs(n);
  bits bit(64);
  exp_bits int;
  frac numeric;
  sig numeric;
  e2 int;
  e10 int;
  k int;
  e int;
  num numeric;
  den numeric;
  p2 int;
  p5 int;
  s0 numeric;
  s numeric;
  low_sig numeric;
  low_e int;
  up_sig numeric;
  up_e int;
  include_tie boolean;
  best numeric;
  best_s numeric;
  best_dist numeric;
  low_cmp int;
  up_cmp int;
  dist numeric;
  guard int := 0;
  rounds boolean;
BEGIN
  IF n <> n OR n = float8 'Infinity' OR n = float8 '-Infinity' THEN
    RETURN NULL;
  END IF;
  -- JavaScript prints both zeros as "0".
  IF abs_n = 0 THEN
    RETURN 0;
  END IF;

  bits := ('x' || encode(float8send(abs_n), 'hex'))::bit(64);
  exp_bits := substring(bits from 2 for 11)::int;
  frac := substring(bits from 13 for 52)::bigint::numeric;
  IF exp_bits = 0 THEN
    sig := frac;
    e2 := -1074;
  ELSE
    sig := frac + power(2::numeric, 52);
    e2 := exp_bits - 1075;
  END IF;

  -- Same rounding interval as Number toString: closest decimal, then the even
  -- significand. Powers of two have a half-sized gap toward zero.
  include_tie := mod(sig, 2) = 0;
  IF exp_bits <> 0 AND frac = 0 THEN
    low_sig := 4 * sig - 1;
    low_e := e2 - 2;
    up_sig := 2 * sig + 1;
    up_e := e2 - 1;
  ELSE
    low_sig := 2 * sig - 1;
    low_e := e2 - 1;
    up_sig := 2 * sig + 1;
    up_e := e2 - 1;
  END IF;

  e10 := floor(log(abs_n))::int;
  WHILE public.js_float_bin_cmp(sig, e2, 1, e10) < 0 LOOP
    e10 := e10 - 1;
    guard := guard + 1;
    IF guard > 8 THEN
      RAISE EXCEPTION 'js_float_decimal exponent correction failed';
    END IF;
  END LOOP;
  guard := 0;
  WHILE public.js_float_bin_cmp(sig, e2, 1, e10 + 1) >= 0 LOOP
    e10 := e10 + 1;
    guard := guard + 1;
    IF guard > 8 THEN
      RAISE EXCEPTION 'js_float_decimal exponent correction failed';
    END IF;
  END LOOP;

  FOR k IN 1..17 LOOP
    e := e10 - k + 1;
    num := sig;
    den := 1;
    p2 := e2 - e;
    p5 := -e;
    IF p2 >= 0 THEN
      num := num * power(2::numeric, p2);
    ELSE
      den := den * power(2::numeric, -p2);
    END IF;
    IF p5 >= 0 THEN
      num := num * power(5::numeric, p5);
    ELSE
      den := den * power(5::numeric, -p5);
    END IF;
    s0 := div(num, den);
    best := NULL;
    best_s := NULL;
    best_dist := NULL;
    FOREACH s IN ARRAY ARRAY[s0, s0 + 1]::numeric[] LOOP
      IF s <= 0 THEN
        CONTINUE;
      END IF;
      low_cmp := public.js_float_bin_cmp(low_sig, low_e, s, e);
      up_cmp := public.js_float_bin_cmp(up_sig, up_e, s, e);
      rounds := (CASE WHEN include_tie THEN low_cmp <= 0 ELSE low_cmp < 0 END)
        AND (CASE WHEN include_tie THEN up_cmp >= 0 ELSE up_cmp > 0 END);
      IF NOT rounds THEN
        CONTINUE;
      END IF;
      dist := abs(num - s * den);
      IF best IS NULL
        OR dist < best_dist
        OR (dist = best_dist AND mod(s, 2) = 0 AND mod(best_s, 2) <> 0) THEN
        best_s := s;
        best_dist := dist;
        best := s * power(10::numeric, e);
      END IF;
    END LOOP;
    IF best IS NOT NULL THEN
      IF n < 0 THEN
        RETURN -best;
      END IF;
      RETURN best;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'js_float_decimal found no round-trip decimal';
END;
$$;
