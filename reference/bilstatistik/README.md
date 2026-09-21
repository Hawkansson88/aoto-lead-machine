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

Begagnade fordon (minst 12 månader gamla) som sålts från en bilhandlare och
registrerats på leasing med ett **företag** som brukare. Alltså företagsleasing
till slutkund, inte privatleasing.

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

`DateRangeOptionId: 1` returnerar transaktioner fram till dagens datum, men om
det är rullande 12 månader eller år-till-datum är obekräftat. Synken förlitar
sig därför inte på den: `prospect-sync.mjs` fönstrar själv 365 dagar bakåt från
senaste transaktionen i datan, och sparar det faktiska spannet i
`app_state.prospect_sync`.
