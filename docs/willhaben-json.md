# willhaben search-result JSON — reference

How the listing data is shaped, and which fields actually exist. willhaben is a
Next.js app: the full result set is embedded as JSON in
`<script id="__NEXT_DATA__">`.

Path to the listings array:

```
__NEXT_DATA__
  → props.pageProps.searchResult.advertSummaryList.advertSummary   (30 per page)
```

Each advert has `attributes.attribute` = an array of `{ name, values: [...] }`.
`content.js` flattens it to `a[name] = values[0]`.

## Sample: one flattened listing (anonymized)

This is the ground truth for what keys are present in the **search-list** payload.
Real values have been replaced with placeholders; only the field names and shapes
matter here.

```json
{
  "LOCATION": "<Stadt>",
  "POSTCODE": "<PLZ>",
  "STATE": "<Bundesland>",
  "BODY_DYN": "<Beschreibungstext …>",
  "ORGNAME": "<Anbietername>",
  "imagedescription": "Bild",
  "ORG_UUID": "<uuid>",
  "ESTATE_SIZE/LIVING_AREA": "<m²>",
  "DISTRICT": "<Bezirk>",
  "HEADING": "<Inseratstitel>",
  "LOCATION_QUALITY": "1.0",
  "FLOOR": "<Stockwerk>",
  "PUBLISHED": "<epoch-ms>",
  "COUNTRY": "Österreich",
  "PRICE/SQUARE_METER": "<zahl>",
  "LOCATION_ID": "<id>",
  "PROPERTY_TYPE": "Wohnung",
  "NUMBER_OF_ROOMS": "<zahl>",
  "ADTYPE_ID": "2",
  "PROPERTY_TYPE_ID": "3",
  "ADID": "<ad-id>",
  "ORGID": "<org-id>",
  "SEO_URL": "immobilien/d/mietwohnungen/<bundesland>/<stadt>/<slug>-<ad-id>/",
  "ALL_IMAGE_URLS": "<pfad>_<n>.jpg;<pfad>_<n>.jpg;<pfad>_<n>.jpg",
  "PUBLISHED_String": "<ISO-8601>",
  "ESTATE_PREFERENCE": "<id, id, …>",
  "UPSELLING_AD_SEARCHRESULT": "true",
  "categorytreeids": "<id>",
  "RENT/PER_MONTH_LETTINGS": "<zahl>",
  "ADVERTISER_REF": "<ref>",
  "PRODUCT_ID": "<id>",
  "IS_BUMPED": "1",
  "MMO": "<pfad>_<n>.jpg",
  "ROOMS": "<zahl>X<zahl>",
  "REFERER": "pp",
  "UNIT_NUMBER": "<top-nr>",
  "AD_UUID": "<uuid>",
  "ADDRESS": "<Straße Hausnummer>",
  "AD_SEARCHRESULT_LOGO": "adSearchResult/<org-id>/<pfad>.png",
  "COORDINATES": "<lat>,<lng>",
  "PRICE": "<zahl>",
  "PRICE_FOR_DISPLAY": "€ <betrag>",
  "PRICE/SQUARE_METER_FOR_DISPLAY": "€ <betrag>",
  "PRICE/SQUARE_METER_FOR_DISPLAY_WITH_UNIT": "€ <betrag>/m²",
  "ESTATE_SIZE": "<m²>",
  "ISPRIVATE": "0",
  "PROPERTY_TYPE_FLAT": "true",
  "UNIT_TITLE": "Etage <n>/Top <nr>"
}
```

## Fields we use (see `content.js` → `parseListings`)

| Field in code | Attribute name(s) | Notes |
|---|---|---|
| `id` | `ad.id` / `ADID` / `AD_UUID` | ad id; also the id the Merkliste API speaks |
| `lat`, `lng` | `COORDINATES` | `"lat,lng"` string; present on every listing |
| `priceNum` | `PRICE` | number string |
| `priceDisplay` | `PRICE_FOR_DISPLAY` | e.g. `"€ …"` |
| `title` | `HEADING` (→ `ad.description`) | |
| `address` | `ADDRESS`, `POSTCODE`, `LOCATION` | joined with `, ` |
| `size` | `ESTATE_SIZE/LIVING_AREA` → `ESTATE_SIZE` | m² |
| `rooms` | `NUMBER_OF_ROOMS` | |
| `floor` | `FLOOR` | plain storey number, e.g. `"4"`; also spelled out in `UNIT_TITLE` (`"Etage 4/Top 18a"`) |
| `images` | `ALL_IMAGE_URLS` (→ `MMO`) | one `";"`-separated string of every photo |
| `url` | `SEO_URL` (→ `ad.selfLink`) | relative; full = `https://www.willhaben.at/iad/` + `SEO_URL` |

Image URL prefix: `https://cache.willhaben.at/mmo/` + path.

## Fields that are NOT in the search list — only on the ad DETAIL page

The **search-list** payload above is a *summary*. The individual **ad detail page**
(`/iad/immobilien/d/.../…-<id>/`) has its own, much richer `__NEXT_DATA__` with ~65
attributes, including several the summary omits. Same shape (`{name, values}`),
reachable by walking `props.pageProps` (path varies, so we walk recursively).

- **Availability ("Verfügbar ab")** — detail page only:
  - `AVAILABLE_NOW` = e.g. `"ab sofort"` — the label willhaben itself displays.
  - `AVAILABLE_DATE` = a concrete date (dd.mm.yyyy).
  - We prefer `AVAILABLE_NOW`, fall back to `AVAILABLE_DATE`.
- Other detail-only fields seen: `BUILDING_TYPE` (Altbau/Neubau),
  `BUILDING_CONDITION`, `FLOOR_SURFACE` (Böden), `HEATING`, `CONSTRUCTION_YEAR`,
  `DURATION/HASTERMLIMIT` (Befristung), `ENERGY_*`, `ESTATE_SIZE/USEABLE_AREA`
  (Nutzfläche), `DESCRIPTION`/`GENERAL_TEXT_ADVERT/*` (rich HTML), contact fields.

Because these aren't in the list, the map fetches the detail page **lazily** when a
popup opens (`content.js` → `fetchDetail`, cached per id; `map.js` → `requestAvail`,
fills the chip on the `willkarte:detail` reply). One request per ad you look at.
Checked 2026-09-07.

## Sample: one detail-page attribute list (anonymized)

All 65 `{name, values}` attributes from one ad's detail page, flattened to
`NAME = values`. Real values are replaced with placeholders; the two rich-HTML
blobs (`DESCRIPTION`, `GENERAL_TEXT_ADVERT/*`) are truncated with `…` — they're
long marketing HTML.

```
DURATION/HASTERMLIMIT              = ["unbefristet"]
FLOOR                              = ["<zahl>"]
RENTAL_PRICE/PER_MONTH_NET         = ["<betrag>"]
ADDITIONAL_COST/FEE                = ["<Provisionshinweis>"]
RENTAL_PRICE/PRICE_DESCRIPTION     = ["siehe Preis - Detailinformation"]
INFOLINK/URL                       = ["<https://…/dokument.pdf>"]
ESTATE_SIZE/USEABLE_AREA           = ["<m²>"]
ENERGY_HWB_CLASS                   = ["<klasse>"]
IMPORT_EXTERNAL_ADVERTISER_ID      = ["<extern-id>"]
CONTACT/URL                        = ["<website>"]
PROPERTY_TYPE_ID                   = ["3"]
BUILDING_TYPE                      = ["Altbau"]
CONTACT/NAME                       = ["<Kontaktname>"]
ESTATE_SIZE/LIVING_AREA            = ["<m²>"]
RENTAL_PRICE/ADDITIONAL_COST_NET   = ["<betrag>"]
AVAILABLE_NOW                      = ["ab sofort"]
PROPERTY_TYPE_FLAT                 = ["true"]
CONTACT/PHONE                      = ["<telefon>"]
OWNAGETYPE                         = ["Miete"]
GENERAL_TEXT_ADVERT/Ausstattung    = ["<ul><li>…</li>… (HTML)"]
INFOLINK/NAME                      = ["Dokument 1"]
GENERAL_TEXT_ADVERT/Lage           = ["<strong>Infrastruktur / Entfernungen</strong>… (HTML)"]
DESCRIPTION                        = ["<p>…</p>… (long HTML)"]
RENTAL_PRICE/TOTAL_ENCUMBRANCE     = ["<betrag>"]
GENERAL_TEXT_ADVERT/Preis - Detailinformation = ["<ul><li>Gesamtbelastung (exkl. MWSt): … Eur</li>… (HTML)"]
CONTACT/COMPANYNAME                = ["<Firmenname>"]
GENERAL_TEXT_ADVERT/Zusatzinformationen = ["<ul><li>Anzahl Etagen: …</li><li>Stockwerk: …</li><li>Anzahl Badezimmer: …</li><li>Energiepass HWB: … kWh/m²/Jahr</li><li>Verfügbar ab: …</li><li>Baujahr: …</li><li>Anzahl WC: …</li><li>Mietdauer: … </li></ul>"]
ENERGY_HWB                         = ["<zahl>"]
CONSTRUCTION_YEAR                  = ["<jahr>"]
FLOOR_SURFACE                      = ["Laminat"]
BUILDING_CONDITION                 = ["Sehr gut/gut"]
CONTACT/PHONE2                     = ["<telefon>"]
ESTATE_PREFERENCE                  = ["Einbauküche","Abstellraum"]
RENTAL_PRICE/PER_MONTH_FOR_DISPLAY = ["€ <betrag>"]
ENERGY_FGEE_CLASS                  = ["<klasse>"]
AVAILABLE_DATE                     = ["<dd.mm.yyyy>"]
ENERGY_FGEE                        = ["<zahl>"]
RENTAL_PRICE/PER_MONTH             = ["<betrag>"]
RENTAL_PRICE/VAT                   = ["<betrag>"]
PROPERTY_TYPE                      = ["Wohnung"]
NO_OF_ROOMS                        = ["<zahl>"]
IMPORT_XML_SOFTWARE                = ["<software>"]
HEATING                            = ["Zentralheizung"]
IMPORT_EXTERNAL_ADVERT_ID          = ["<extern-id>"]
PRICE                              = ["<zahl>"]
PRICE_FOR_DISPLAY                  = ["€ <betrag>"]
AREA_ID                            = ["<id>"]
REGION_AREA_ID                     = ["<id>"]
LOCATION/ADDRESS_2                 = ["<Stadt>"]
LOCATION/ADDRESS_3                 = ["<Stadt>"]
LOCATION/ADDRESS_4                 = ["<Bundesland>"]
COORDINATES                        = ["<lat>,<lng>"]
POSITION_RADIUS_METERS             = ["<meter>"]
SHOW_MAP                           = ["true"]
SHOW_SHADOWMAP                     = ["false"]
CONTACT/COMPANY                    = ["<Firmenname>"]
CONTACT/ADDRESS_STREET             = ["<Straße Hausnummer>"]
CONTACT/ADDRESS_POSTCODE           = ["<PLZ>"]
CONTACT/ADDRESS_TOWN               = ["<Ort, Bezirk>"]
ISPRIVATE                          = ["0"]
DEALER                             = ["1"]
ORG_TYPE                           = ["105"]
PRICE/SQUARE_METER                 = ["<zahl>"]
PRICE/SQUARE_METER_FOR_DISPLAY     = ["€ <betrag>"]
PRICE/SQUARE_METER_FOR_DISPLAY_WITH_UNIT = ["€ <betrag>/m²"]
```

Note: `POSITION_RADIUS_METERS` confirms the README's accuracy caveat — willhaben
tells you the position is only good to a radius. And
`GENERAL_TEXT_ADVERT/Zusatzinformationen` restates several facts in free HTML
(`Stockwerk`, `Verfügbar ab`, `Baujahr`) — a fallback source if a structured
attribute is ever missing.
