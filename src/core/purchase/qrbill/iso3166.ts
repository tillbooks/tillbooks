/**
 * ISO 3166-1 alpha-2, the officially assigned codes: what IG v2.3 Table 8 means by "Two-digit country
 * code according to ISO 3166-1" for `Ctry` (critic L3, 30.09.2026: a shape check let `XX` through).
 *
 * A static list and no dependency. Not typed from memory: fetched 30.09.2026 from two independent
 * published datasets (github.com/datasets/country-list `data.csv` and
 * github.com/lukes/ISO-3166-Countries-with-Regional-Codes `slim-2.csv`), which agreed code for code on
 * 249 entries. User-assigned and reserved codes are not ISO 3166-1 assignments and are refused, with ONE
 * exception decided by the owner on 30.09.2026 and handled in `decode.ts`, not here: XK (Kosovo) is
 * accepted with the `country_user_assigned` warning. This list stays the pure ISO list. A change to the standard is a deliberate edit here, never a silent ride-along.
 */
export const ISO_3166_ALPHA2: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV ' +
    'BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ' +
    'ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE ' +
    'IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY ' +
    'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU ' +
    'NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM ' +
    'SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE ' +
    'VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);
