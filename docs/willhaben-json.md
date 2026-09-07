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

## Sample: one flattened listing (Graz Mietwohnung, captured 2026-09-07)

This is the ground truth for what keys are present in the **search-list** payload.

```json
{
  "LOCATION": "Graz",
  "POSTCODE": "8020",
  "STATE": "Steiermark",
  "BODY_DYN": "Exklusive 3-Zimmer-Wohnung mit traumhafter Aussicht - Modernes Wohnen in Graz Top-Lage im Trendviertel Lend Die Wohnung liegt in der Wiener Straße 60a - zentral in Graz, mit bester Anbindung und zahlreichen Annehmlichkeiten in unmittelbarer Umgebung....",
  "ORGNAME": "Projekt Wohnen",
  "imagedescription": "Bild",
  "ORG_UUID": "4958362f-63e9-4219-bf66-b80186fc3b9f",
  "ESTATE_SIZE/LIVING_AREA": "70",
  "DISTRICT": "Graz",
  "HEADING": "WOW I MODERN SANIERT I OFFENE KÜCHE I 4. STOCK MIT LIFT I BADEWANNE I HAUSTIERE WILLKOMMEN I PROJEKT WOHNEN I",
  "LOCATION_QUALITY": "1.0",
  "FLOOR": "4",
  "PUBLISHED": "1788438868545",
  "COUNTRY": "Österreich",
  "PRICE/SQUARE_METER": "11.382286",
  "LOCATION_ID": "118001",
  "PROPERTY_TYPE": "Wohnung",
  "NUMBER_OF_ROOMS": "3",
  "ADTYPE_ID": "2",
  "PROPERTY_TYPE_ID": "3",
  "ADID": "1563857127",
  "ORGID": "28226852",
  "SEO_URL": "immobilien/d/mietwohnungen/steiermark/graz/wow-i-modern-saniert-i-offene-kueche-i-4-stock-mit-lift-i-badewanne-i-haustiere-willkommen-i-projekt-wohnen-i-1563857127/",
  "ALL_IMAGE_URLS": "7/156/385/7127_1395283898.jpg;7/156/385/7127_1902648449.jpg;7/156/385/7127_1912083631.jpg;7/156/385/7127_206868290.jpg;7/156/385/7127_1178431351.jpg;7/156/385/7127_-1146540226.jpg;7/156/385/7127_1765341297.jpg;7/156/385/7127_-444656121.jpg;7/156/385/7127_920983529.jpg;7/156/385/7127_-1564367212.jpg;7/156/385/7127_-1185730056.jpg",
  "PUBLISHED_String": "2026-09-03T14:34:28Z",
  "ESTATE_PREFERENCE": "24, 250, 27, 4",
  "UPSELLING_AD_SEARCHRESULT": "true",
  "categorytreeids": "7276",
  "RENT/PER_MONTH_LETTINGS": "796.76",
  "ADVERTISER_REF": "38476",
  "PRODUCT_ID": "227",
  "IS_BUMPED": "1",
  "MMO": "7/156/385/7127_1395283898.jpg",
  "ROOMS": "3X3",
  "REFERER": "pp",
  "UNIT_NUMBER": "18a",
  "AD_UUID": "01a01f27-13e2-7d17-a89c-cf050424b4d9",
  "ADDRESS": "Wiener Straße 60a",
  "AD_SEARCHRESULT_LOGO": "adSearchResult/28226852/imageupload12651399956946387753pwlogofarbe_8210087277307350507.png",
  "COORDINATES": "47.0808668,15.4234101",
  "PRICE": "796.76",
  "PRICE_FOR_DISPLAY": "€ 796,76",
  "PRICE/SQUARE_METER_FOR_DISPLAY": "€ 11,38",
  "PRICE/SQUARE_METER_FOR_DISPLAY_WITH_UNIT": "€ 11,38/m²",
  "ESTATE_SIZE": "70",
  "ISPRIVATE": "0",
  "PROPERTY_TYPE_FLAT": "true",
  "UNIT_TITLE": "Etage 4/Top 18a"
}
```

## Fields we use (see `content.js` → `parseListings`)

| Field in code | Attribute name(s) | Notes |
|---|---|---|
| `id` | `ad.id` / `ADID` / `AD_UUID` | ad id; also the id the Merkliste API speaks |
| `lat`, `lng` | `COORDINATES` | `"lat,lng"` string; present on every listing |
| `priceNum` | `PRICE` | number string |
| `priceDisplay` | `PRICE_FOR_DISPLAY` | e.g. `"€ 796,76"` |
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
  - `AVAILABLE_DATE` = e.g. `"05.09.2026"` — a concrete date (dd.mm.yyyy).
  - We prefer `AVAILABLE_NOW`, fall back to `AVAILABLE_DATE`.
- Other detail-only fields seen: `BUILDING_TYPE` (Altbau/Neubau),
  `BUILDING_CONDITION`, `FLOOR_SURFACE` (Böden), `HEATING`, `CONSTRUCTION_YEAR`,
  `DURATION/HASTERMLIMIT` (Befristung), `ENERGY_*`, `ESTATE_SIZE/USEABLE_AREA`
  (Nutzfläche), `DESCRIPTION`/`GENERAL_TEXT_ADVERT/*` (rich HTML), contact fields.

Because these aren't in the list, the map fetches the detail page **lazily** when a
popup opens (`content.js` → `fetchDetail`, cached per id; `map.js` → `requestAvail`,
fills the chip on the `willkarte:detail` reply). One request per ad you look at.
Checked 2026-09-07.

## Sample: one detail-page attribute list (Graz Trauttmannsdorfgasse, 2026-09-07)

All 65 `{name, values}` attributes from one ad's detail page, flattened to
`NAME = values`. The two rich-HTML blobs (`DESCRIPTION`,
`GENERAL_TEXT_ADVERT/*`) are truncated with `…` — they're long marketing HTML.

```
DURATION/HASTERMLIMIT              = ["unbefristet"]
FLOOR                              = ["1"]
RENTAL_PRICE/PER_MONTH_NET         = ["508,85"]
ADDITIONAL_COST/FEE                = ["Gemäß Erstauftraggeberprinzip bezahlt der Abgeber die Provision."]
RENTAL_PRICE/PRICE_DESCRIPTION     = ["siehe Preis - Detailinformation"]
INFOLINK/URL                       = ["https://storage.justimmo.at/file/69MGO1tSyPmslJt842aMtZ.pdf"]
ESTATE_SIZE/USEABLE_AREA           = ["43,75"]
ENERGY_HWB_CLASS                   = ["D"]
IMPORT_EXTERNAL_ADVERTISER_ID      = ["ABGC202501071240025038542bb28cb"]
CONTACT/URL                        = ["www.prime-immobilien.at"]
PROPERTY_TYPE_ID                   = ["3"]
BUILDING_TYPE                      = ["Altbau"]
CONTACT/NAME                       = ["Benjamin Ghabras"]
ESTATE_SIZE/LIVING_AREA            = ["43,75"]
RENTAL_PRICE/ADDITIONAL_COST_NET   = ["107,3"]
AVAILABLE_NOW                      = ["ab sofort"]
PROPERTY_TYPE_FLAT                 = ["true"]
CONTACT/PHONE                      = ["004318102230"]
OWNAGETYPE                         = ["Miete"]
GENERAL_TEXT_ADVERT/Ausstattung    = ["<ul><li>Abstellraum Anzahl: 1</li>… (HTML)"]
INFOLINK/NAME                      = ["Dokument 1"]
GENERAL_TEXT_ADVERT/Lage           = ["<strong>Infrastruktur / Entfernungen</strong>… (HTML)"]
DESCRIPTION                        = ["<p> </p><br><p><strong>Modernisierter Altbau…</strong>… (long HTML)"]
RENTAL_PRICE/TOTAL_ENCUMBRANCE     = ["559,74"]
GENERAL_TEXT_ADVERT/Preis - Detailinformation = ["<ul><li>Gesamtbelastung (exkl. MWSt): 508,85 Eur</li>… (HTML)"]
CONTACT/COMPANYNAME                = ["RIMMO Prime Vermittlungs GmbH"]
GENERAL_TEXT_ADVERT/Zusatzinformationen = ["<ul><li>Anzahl Etagen: 3</li><li>Stockwerk: 1. Etage / 1.Obergeschoss</li><li>Anzahl Badezimmer: 1</li><li>Energiepass HWB: 128.2 kWh/m²/Jahr</li><li>Verfügbar ab: sofort</li><li>Baujahr: 1905</li><li>Anzahl WC: 1</li><li>Mietdauer: unbefristet </li></ul>"]
ENERGY_HWB                         = ["128,2"]
CONSTRUCTION_YEAR                  = ["1905"]
FLOOR_SURFACE                      = ["Laminat"]
BUILDING_CONDITION                 = ["Sehr gut/gut"]
CONTACT/PHONE2                     = ["00436642323557"]
ESTATE_PREFERENCE                  = ["Einbauküche","Abstellraum"]
RENTAL_PRICE/PER_MONTH_FOR_DISPLAY = ["€ 559,74"]
ENERGY_FGEE_CLASS                  = ["D"]
AVAILABLE_DATE                     = ["05.09.2026"]
ENERGY_FGEE                        = ["1,86"]
RENTAL_PRICE/PER_MONTH             = ["559,74"]
RENTAL_PRICE/VAT                   = ["50,89"]
PROPERTY_TYPE                      = ["Wohnung"]
NO_OF_ROOMS                        = ["1"]
IMPORT_XML_SOFTWARE                = ["JUSTIMMO"]
HEATING                            = ["Zentralheizung"]
IMPORT_EXTERNAL_ADVERT_ID          = ["OBGC202501182148136582113ac8770"]
PRICE                              = ["559.74"]
PRICE_FOR_DISPLAY                  = ["€ 559,74"]
AREA_ID                            = ["118001"]
REGION_AREA_ID                     = ["601"]
LOCATION/ADDRESS_2                 = ["Graz"]
LOCATION/ADDRESS_3                 = ["Graz"]
LOCATION/ADDRESS_4                 = ["Steiermark"]
COORDINATES                        = ["47.07015,15.444996"]
POSITION_RADIUS_METERS             = ["266"]
SHOW_MAP                           = ["true"]
SHOW_SHADOWMAP                     = ["false"]
CONTACT/COMPANY                    = ["RIMMO Prime Vermittlungs GmbH"]
CONTACT/ADDRESS_STREET             = ["Handelskai 94 -96/10. OG"]
CONTACT/ADDRESS_POSTCODE           = ["1200"]
CONTACT/ADDRESS_TOWN               = ["Wien, 20. Bezirk, Brigittenau"]
ISPRIVATE                          = ["0"]
DEALER                             = ["1"]
ORG_TYPE                           = ["105"]
PRICE/SQUARE_METER                 = ["12.794057"]
PRICE/SQUARE_METER_FOR_DISPLAY     = ["€ 12,79"]
PRICE/SQUARE_METER_FOR_DISPLAY_WITH_UNIT = ["€ 12,79/m²"]
```

Note: `POSITION_RADIUS_METERS` (`266`) confirms the README's accuracy caveat —
willhaben tells you the position is only good to a radius. And
`GENERAL_TEXT_ADVERT/Zusatzinformationen` restates several facts in free HTML
(`Stockwerk`, `Verfügbar ab`, `Baujahr`) — a fallback source if a structured
attribute is ever missing.
