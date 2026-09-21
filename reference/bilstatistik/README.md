# Bilstatistik — leasingaffärer till slutkund

Referensuttag som prospektlistan bygger på. Filerna är sparade som de såg ut när
rapportprofilen togs fram, så att filtret går att förstå och ändra utan att
bränna ett nytt uttag (Bilstatistik har en frågegräns per dygn).

| Fil | Innehåll |
|---|---|
| `leasing-slutkund-request.json` | Request-bodyn, en rad per bil |
| `leasing-slutkund-response-sample.json` | Första sidan av svaret (100 av ~12 900 rader) |

Profilen är implementerad i `netlify/functions/prospect-sync.mjs`
(`buildLeasingSalesRequest`).

## Vad rapporten fångar

Fordon som sålts från en bilhandlare och registrerats på leasing med ett
**företag** som brukare. Alltså företagsleasing till slutkund, inte
privatleasing.

Åldersgränsen styrs av `AgeInMonthsRange.From` och står på **1 månad**, alltså
allt utom fabriksnytt. Den var 12 månader i de sparade referensfilerna, då
urvalet var rent begagnat.

## Fyra parter per rad

| Roll | Kolumn | Filter |
|---|---|---|
| Säljande ÅF | `PreviousPrimaryUser` | Bransch = bilhandel — **det här är prospektet** |
| Föregående ägare | `PreviousPrimaryOwner` | Inget branschkrav, se nedan |
| Leasinggivare | `PrimaryOwner` | Ej bilhandel — AOTO:s konkurrent på affären |
| Slutkund | `PrimaryUser` | Företag, ej bilhandel |

ÅF:en identifieras via föregående **brukare**, inte föregående ägare. När bilen
legat på lagerfinansiering står finansbolaget som ägare medan ÅF:en är brukare,
och det gäller ungefär var tredje rad. Ett branschfilter på `PreviousOwner`
skulle därför slå bort en tredjedel av de äkta ÅF-affärerna — hårdast mot just
de handlare som redan är vana vid finansierade upplägg.

## Branschkoder

```
5803, 5805, 5876, 5878, 5999, 6001   bilhandel
6209, 6210                           finans/leasing (verkar vara — se nedan)
```

6209/6210 ligger kvar i `PreviousUser`-filtret. De släpper igenom enstaka
leasingbolag (Ayvens dök upp på 1 rad av 100), men att stänga ute dem i API:t
riskerar att samtidigt tappa äkta handlare. De rensas istället lokalt via
tabellen `prospect_exclusions`, som går att redigera utan nytt uttag.

## Utdatakolumner

`OutputColumns: [87, 88, 156, 157, 1, 108, 37, 155, 4]` ger:

| Id | Kolumn |
|---|---|
| 87 | `RegistrationNumber` |
| 88 | `Date` |
| 156 | `PreviousPrimaryUserDisplayName` |
| 157 | `PreviousPrimaryUserVisibleCompanyRegistrationNumber` |
| 1 | `MakeName` |
| 108 | `CurrentStateDurationDisplayString` (innehavstid) |
| 37 | `PrimaryOwnerDisplayName` |
| 155 | `PreviousPrimaryOwnerVisibleCompanyRegistrationNumber` |
| 4 | `PrimaryUserDisplayName` |

## Perioden

Uppmätt mot verkliga uttag:

| DateRangeOptionId | Period |
|---|---|
| 1 | år-till-datum |
| 5 | föregående kalenderår |

**Rullande 12 månader finns inte som alternativ.** Lösningen är att hämta båda
perioderna en gång var och låta 365-dagarsfönstret i
`recompute_prospect_dealers()` skära ut det rullande året ur den samlade
rådatan. Överlapp är ofarligt: `UNIQUE (reg_nr, tx_date, dealer_org_nr)`
rensar det.

Hämtningen körs med `node scripts/prospect-pull.mjs --period ytd` respektive
`--period forra-aret`. Det faktiska spannet sparas i `app_state.prospect_sync`.

## Radkvot, inte frågekvot

Bilstatistik kvoterar **ReportRows** — antalet returnerade rader — inte antalet
frågor. Felet lyder `ReportRows quota exeeded limits. Retry after 604800
seconds`, alltså en vecka.

Det gör formen på uttaget viktigare än antalet. Behövs bara ett *antal* per
bolag räcker `count=1` med org.nr i filtret: svaret bär ändå `TotalRowCount`.
1 212 handlare kostar då 1 212 rader i stället för ~150 000.

`scripts/prospect-probe.mjs` hämtar några rader och visar vad ett fullt uttag
skulle kosta, innan man spenderar det.

## Nyttiga utdatakolumner

| Id | Kolumn |
|---|---|
| 4 | `PrimaryUserDisplayName` — slutkundens namn |
| 34 | `PrimaryUserCompanyRegistrationNumber` — slutkundens org.nr |
| 35 | `PrimaryUserTrade` — slutkundens SNI, t.ex. "47920 Förmedling avseende specialiserad detaljhandel" |
| 37 | `PrimaryOwnerDisplayName` — leasinggivaren |
| 38 | `PrimaryOwnerCompanyRegistrationNumber` |
| 39 | `PrimaryOwnerTrade` |
| 154/155 | Föregående ägare: namn / org.nr |
| 156/157 | Föregående brukare: namn / org.nr |

## Mellanhänder i nämnaren

Handlare gör sig av med inbyten via B2B-auktioner. De plattformarna är inte
registrerade som bilhandel — AUTOproff och Handlarbudet har SNI 47920 — och
slipper därför igenom branschfiltret.

Tesla (TM Sweden) hade 1 054 "företagsaffärer" år till datum. Filtrerar man
bort AUTOproff återstår 306.

`CompanyTrades` kräver Bilstatistiks egna numeriska id och accepterar inte SNI
(`TradeName` utan `Values` avvisas). Lösningen är `CompanyIdentifiers` med
`Negate` på Owner och User — verifierat att fungera. Listan underhålls i
`prospect_buyer_exclusions`.
