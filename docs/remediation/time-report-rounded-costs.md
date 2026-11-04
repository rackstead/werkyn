# Time-report cost calculation

Each billable entry uses the historical rate effective on its own date. The
report interprets persisted finite hours and rates by their decimal Number
spellings, multiplies with integer decimal arithmetic, and rounds that entry to
its currency's fraction digits. Nearest ties go away from zero. Currency totals
sum those same rounded entries: three 0.1-hour USD entries at 33.33 per hour each
cost 3.33, for a total of 9.99 in the API, report and CSV.

The server supplies the precision used for each entry and currency bucket. UI
and CSV use it explicitly: JPY has 0 digits, USD 2, KWD 3 and CLF 4. Unknown or invalid
legacy codes retain the existing two-digit fallback; this does not validate or
repair currency codes. This is currency decimal precision, not cash-increment
rounding. CSV Rate and Hours keep their existing display precision; cost is
calculated from the stored inputs, not those displayed cells.
CSV cost text pads the validated API decimal spelling without rounding the
underlying binary Number again, including large accepted amounts.

Reports keep currencies separate, missing billable rates unpriced and flagged,
nonbillable costs zero, and zero-rate buckets present. Existing numeric API
fields remain, with additive `fractionDigits` on currency buckets and
`costFractionDigits` on entries. An amount must fit the safe integer minor-unit
bound and round-trip through its numeric JSON spelling without losing a unit.
An unsupported entry, group or summary returns 400 for both report and export,
instead of an inaccurate total or blank cost. Stored inputs are never changed.

No database migration is needed. Float storage remains; this calculation does
not recover decimal precision lost before storage or change rates, currency
selection, effective dates or historical entries. Earlier reports and exports
can consequently show different rounded costs under this selected policy.

## Editing hourly rates

Manage Rates provides an amount and a three-letter currency field, with explicit
Save and Cancel. Currency-only changes keep the displayed rate, including its
stored precision; moving between fields does not save. Currency letters are
uppercased by the existing shared contract, without adding an ISO-only list.
The editor uses the rate in force on today's UTC date, excluding future rates.

Each draft captures the values shown when editing begins. Amount-only changes
omit the unchanged currency, preserving the API's existing optional-field
behavior. A changed currency sends that currency and the reviewed amount.
The existing last-writer API remains: this does not add revisions or preserve a
required rate concurrently changed by another writer. Failed saves retain the
draft for an explicit retry; pending saves prevent duplicate submissions.
