# AOTO Prospekt

Fristående prospektlista för slutkundsleasing, byggd för hösten 2026. Ligger i
samma repo som CRM:et men delar inget gränssnitt med det — bara inloggning och
databas.

Öppnas på `/prospekt.html`. Kör `netlify dev` lokalt; sidan är en ES-modul och
fungerar inte över `file://`.

## Vad listan visar

Återförsäljare rankade på **antal leasingaffärer till företagskund hittills i
år**, hämtade från Bilstatistik. Klassas A, B eller C och fördelas mellan Anton och Marc.

Varje rad i grunddatan är en enskild bil. Säljaren identifieras via
**föregående brukare**, inte föregående ägare: när en bil ligger på
lagerfinansiering står finansbolaget som ägare medan handlaren är brukare, och
det gäller ungefär var tredje affär.

## Filer

| Fil | Roll |
|---|---|
| `prospekt.html`, `js/prospekt.js`, `css/prospekt.css` | Sidan |
| `js/prospekt-map.js` | Kartan — radie runt en ort, eller korridor längs en sträcka |
| `netlify/functions/prospect-sync.mjs` | Request-byggare och hämtningslogik |
| `scripts/prospect-pull.mjs` | Hämtar leasingaffärer |
| `scripts/prospect-b2b-counts.mjs` | Nämnaren till leasingandelen |
| `scripts/prospect-geocode.mjs` | Geokodar adresser via Nominatim |
| `scripts/prospect-probe.mjs` | Vad kostar ett uttag? Kör före ett skarpt |
| `scripts/prospect-dealer-sample.mjs` | Dubbelkolla en enskild handlare |
| `supabase/prospect_*.sql` | Tabeller och omräkningsfunktion |
| `reference/bilstatistik/` | Rapportprofilen, kolumn-id:n, kvotanteckningar |

Sidan anropar aldrig Bilstatistik. Uttag körs från `scripts/`, eftersom kvoten
räknas i rader per vecka och ett felklick inte ska kunna bränna den.

## Kvoten

Bilstatistik kvoterar **antal returnerade rader**, inte antal frågor, och
fönstret är sju dygn. Behövs bara ett antal per bolag räcker `count=1` med
org.nr i filtret — svaret bär ändå `TotalRowCount`. 1 212 handlare kostar då
1 212 rader i stället för ~150 000.

Kör `scripts/prospect-probe.mjs` innan ett skarpt uttag.

## Siffror som inte är vad de ser ut att vara

Tre gånger under bygget har ett tal sett jämförbart ut utan att vara det:

1. Beståndsimportens `salj_foretag_12m` räknade partihandel mellan bilfirmor —
   uppblåst mellan 1 och 22 gånger beroende på hur mycket grossistförsäljning
   bolaget gör.
2. B2B-auktioner som AUTOproff och Handlarbudet räknades som företagskunder.
   Tesla hade 1 054 "företagsaffärer", varav 748 till AUTOproff ensamt.
3. Samma mellanhänder fanns även i täljaren, vilket gav andelar över 100 %.

Teslas leasingandel gick från 6 % till 86 % när allt var rättat.

4. "Affärer" räknades över rullande 12 månader medan leasingandelen gällde år
   till datum. Riddermark visade 1 684 affärer men "1 227 av 2 479" — två olika
   leasingtal bredvid varandra. Nu räknas allt från 1 januari och med samma
   uteslutna köpare, så Affärer är exakt andelens täljare. Kör om
   `prospect-b2b-counts.mjs` efter ett nytt leasinguttag, annars hänger
   andelen efter.

**Därav regeln:** ser ett tal konstigt ut är det oftast ett filterfel, inte ett
verkligt utfall. Kör `scripts/prospect-dealer-sample.mjs --org <nr>` och se
vilka som faktiskt köper. Och visa hellre streck än ett tal som kan vara fel —
blandad rätt och fel i samma kolumn är värre än saknad data.

Leasingandelen bär därför en tillförlitlighetsmarkering. Logiken är aritmetisk:
en okänd mellanhand kan bara blåsa upp nämnaren, aldrig täljaren, så felet drar
alltid andelen nedåt. Ett högt tal kan inte vara felaktigt uppblåst; ett lågt
tal behöver kontrolleras.

## Nästa steg

Väntar på att radkvoten släpper, omkring 28 september 2026:

- `node scripts/prospect-b2b-counts.mjs --limit 150` — nämnare åt de 30 som
  saknas plus 50 till
- Nytt leasinguttag, så rådatan bär köparens org.nr och SNI (kolumn 34/35). Då
  går mellanhänder med SNI 47920 att hitta automatiskt i stället för en och en.
- Gå igenom `prospect_exclusions`. De 22 mönstren är gissade, och flera är
  redan medvetet överkörda.
