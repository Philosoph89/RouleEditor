// Anschlussdokumentation der Anlage — GENERIERT, nicht von Hand ändern.
//
// Quelle: docs/Modulbelegung_Gesamt.xlsx und
//         docs/Gesamtuebersicht_Modulanschluesse_1A_bis_44_v3.xlsx
// Neu erzeugen mit:  node tools/gen-connections.mjs
//
// Die Klemmennummer der Dokumentation ist NICHT die Busadresse. Die Zuordnung
// ist gegen die Regelbasis geprüft (siehe test/connections.test.js):
//
//   A x/n   Ausgang    -> Sub 0, Bit n     ("Dimmer" im Text -> Dimmerkanal M.3/M.4)
//   S x/n   Status-LED -> Sub 1, Bit n
//   E x/n   Eingang    -> n<=7: Sub 0, Bit n | n>=8: Sub 2, Bit n-8
//
// Belege für die Eingangs-Zuordnung: E10/10 und E10/11 sind der zweite
// Rolladentaster im Gästezimmer ("an Tür auf/zu") — die Regelbasis hat genau
// dort die Auslöser 10.2.2 und 10.2.3. Ebenso E30/9 -> 30.2.1 und E30/11 -> 30.2.3.
// Für Sub 1 spricht S10/2 = "1. Ausgang Anzeige Lüftung im Wohnzimmer": genau
// dieses Bit (10.1.2) schreibt die Stufen-LED-Tabelle der Lüftung.

export const CONNECTIONS = {
  '10': {
    room: "Gästezimmer Süd 1.v. links",
    hwText: "Dimmer Modul V95 V2.0",
    A: { 0: "Rolladenausgang Gästezimmer auf", 1: "Rolladenausgang Gästezimmer zu", 2: "Steckdose Fenster", 3: "Steckdose neben Fernsehanschluß", 4: "Dimmausgang Lampe Gästezimmer [Dimmer]" },
    S: { 0: "Rolladenschalter am Fenster Statusanzeige Gästezimmer", 2: "1. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Rolladenschalter Gästezimmer auf", 1: "Rolladenschalter Gästezimmer zu", 2: "Sonnenfühler Gästezimmer links", 3: "Sonnenfühler Speisekammer", 4: "Sonnenfühler Küche Ost", 5: "Lichtschalter Gästezimmer", 6: "Rauchmelder Gästezimmer", 7: "Paniktaster Gästezimmer hinter Tür", 8: "Taster Zirkulation Warmwasser (zur Zeit Speisekammerlichttaster länger als 1s drücken)", 9: "Taster Licht Arbeitsfläche Küche Steckdose schaltbar umlegen in Licht", 10: "Rolladenschalter Gästezimmer an Tür auf", 11: "Rolladenschalter Gästezimmer an Tür zu" },
  },
  '11': {
    room: "Gästezimmer Süd 2.v. links",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Rolladenausgang Speisekammer auf", 1: "Rolladenausgang Speisekammer zu", 2: "Lampe Speisekammer", 3: "Steckdose Gästezimmer Südseite ganz rechts", 4: "Dimmausgang Lampe Küche [Dimmer]" },
    S: { 0: "Rolladenschalter am Fenster Statusanzeige Speisekammer", 2: "2. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Sabotagekontakt Speisekammer", 1: "Sabotagekontakt Gästezimmer", 2: "Readkontakt Gästezimmer links", 3: "Readkontakt Speisekammer", 4: "Readkontakt Gästezimmer rechts", 5: "Rolladenschalter Speisekammer auf", 6: "Rolladenschalter Speisekammer zu", 7: "Paniktaster Speisekammer hinter Tür" },
  },
  '12': {
    room: "Küche unten links Wand zu Wohnzimmer",
    hwText: "Relais-Modul V72 V1.3",
    A: { 0: "Rolladenausgang Küche Ost auf", 1: "Rolladenausgang Küche Ost zu", 2: "Rolladenausgang Küche Süd auf", 3: "Rolladenausgang Küche Süd zu", 4: "Steckdose Fensterlaibung Küche", 5: "Steckdose rechts neben Fenster oben", 6: "Steckdose rechts neben Fenster unten", 7: "Steckdose links neben Fenster unter Rolladentaster" },
    S: { 0: "Rolladenschalter Statusanzeige Küche Ost", 2: "Rolladenschalter Statusanzeige Küche Süd" },
    E: { 0: "Rolladenschalter Küche Ost auf", 1: "Rolladenschalter Küche Ost zu", 2: "Rolladenschalter Küche Süd auf", 3: "Rolladenschalter Küche Süd zu", 4: "Sonnenfühler Küche Süd", 5: "Kaminlichtschalter an WZ-Tür über Kaminlichtsteckdose", 6: "Sonnenfühler WZ 1-flgl. Terrassentür", 7: "Lichtschalter Küche" },
  },
  '13': {
    room: "WZ-Ebecke im Erker von links das erste",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Steckdose Staubsauger Eßecke", 1: "Steckdose neben PC-Anschluß (verlängerte Küchenwand)", 2: "Steckdose erste rechts neben 1-flgl. Terrassentür", 3: "Steckdose zweite rechts neben 1-flgl. Terrassentür", 4: "2x schwarz Lampen große Terrasse 2 Stück am Haus [Dimmer]" },
    S: { 0: "Statusanzeige Steckdose außen, links 2. Reihe oben neben 1flgl. Terrassentür", 2: "3. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Readkontakt Küche Ost links", 1: "Readkontakt Küche Ost rechts", 2: "Readkontakt Küche Süd", 3: "Sabotagekontakt Küche gesamt", 4: "Rolladenzentraltaster Küche auf", 5: "Rolladenzentraltaster Küche zu", 6: "WZ Lichtschalter Eßecke (bei Küchentür)", 7: "2. Schalter Steckdose außen links 2-te Reihe oben neben 1-flgl. Terrassentür" },
  },
  '14': {
    room: "WZ-Ebecke im Erker von links das zweite",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Rolladen Erker mitte auf", 1: "Rolladen Erker mitte zu", 2: "Rolladen Erker links auf", 3: "Rolladen Erker links zu", 4: "Licht über Eßtisch im WZ [Dimmer]" },
    S: { 0: "Rolladenschalter Statusanzeige Erker links", 2: "Rolladenschalter Statusanzeige Erker mitte" },
    E: { 0: "Rolladen Erker links auf", 1: "Rolladen Erker links zu", 2: "Rolladen Erker mitte auf", 3: "Rolladen Erker mitte zu", 4: "Sonnenfühler Erkerfenster rechts (rechte Seite)", 5: "Rolladenzentraltaster Erker auf (an Terrassentür links 1-flgl. Terrassentür 2.Reihe unten)", 6: "Sonnenfühler Erkerfenster links (linke Seite)", 7: "Rolladenzentraltaster Erker zu (an Terrassentür links neben 1-flgl. Terrassentür 2.Reihe unten)" },
  },
  '15': {
    room: "Eßecke im Erker von rechts das zweite",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Rolladen 2-flgl. Terrassentür auf", 1: "Rolladen 2-flgl. Terrassentür zu", 2: "Steckdose Erkerfenster mitte rechte Seite", 3: "Steckdose Erkerfenster mitte linke Seite", 4: "Licht im Erker Sternenhimmel im WZ [Dimmer]" },
    S: { 0: "Rolladenschalter Statusanzeige 1-flgl. Terrassentür", 2: "4. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Readkontakt Erker links links", 1: "Readkontakt Erker links mitte", 2: "Readkontakt Erker links rechts", 3: "Sabotagekontakt Erker gesamt", 4: "Sonnenfühler Erkerfenster rechts (rechte Seite)", 5: "Rolladen 1-flgl. Terrassentür auf", 6: "Rolladen 1-flgl. Terrassentür zu", 7: "Licht im Erker Sternenhimmel unterer Lichtschalter an 1-flgl. Terrassentür" },
  },
  '16': {
    room: "Eßecke im Erker von rechts das erste",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Rolladen Erker rechts auf", 1: "Rolladen Erker rechts zu", 2: "Rolladen 1-flgl. Terrassentür auf", 3: "Rolladen 1-flgl. Terrassentür zu", 4: "Steckdose in der Sitzecke Süd neben 2-flgl. Terrassentür rechts unten [Dimmer]" },
    S: { 0: "Rolladenschalter Statusanzeige Erker rechts", 2: "Rolladenschalter Statusanzeige 2-flgl. Terrassentür" },
    E: { 0: "Rolladen Erker rechts auf", 1: "Rolladen Erker rechts zu", 2: "Readkontakt 1-flgl. Terrassentür", 3: "Readkontakt 2-flgl. Terrassentür", 4: "Sabotagekontakt Fenstertüren WZ", 5: "Rolladen 2-flgl. Terrassentür auf", 6: "Rolladen 2-flgl. Terrassentür zu", 7: "Lichtschalter Außenlicht Terrasse 2. Reihe links neben 1-flgl. Terrassentür oben" },
  },
  '17': {
    room: "Wohnzimmer neben Fernseher links",
    hwText: "Relais-Modul V72 V1.3",
    A: { 0: "Rolladen Gästeklo auf", 1: "Rolladen Gästeklo zu", 2: "Rolladen WZ West auf", 3: "Rolladen WZ West zu", 4: "Licht im Gästeklo an der Decke", 5: "Steckdose hinter Fernseher ganz unten links", 6: "Steckdose neben Fernsehkabel Nord-West-Ecke Sitzecke", 7: "Steckdose Heizkörper Gästeklo" },
    S: { 0: "Rolladenschalter Statusanzeige WZ West", 2: "Rolladenschalter Statusanzeige Heizkörper Gästeklo" },
    E: { 0: "Rolladenzentraltaster WZ neben Stubentür auf", 1: "Rolladenzentraltaster WZ neben Stubentür zu", 2: "Schalter Heizung Gästeklo", 3: "Sonnenfühler WZ-West Fenster", 4: "Rolladenschalter WZ-West Fenster auf", 5: "Rolladenschalter WZ-West Fenster zu", 6: "Lichtschalter neben 1-flgl. Terrassentür oben links Licht Eßecke", 7: "Lichtschalter neben Stubentür oben rechts Licht Sitzecke", 8: "Lichtschalter neben Stubentür oben rechts Licht Sitzecke" },
  },
  '18': {
    room: "Wohnzimmer neben Fernseher rechts",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Außenlicht an der Haustür", 1: "Licht an schräger Wand im Flur unten (Garderobe)", 2: "Licht Flurlicht unten (Ausgang über Gästeklo oben mitte (Trafo über HWR Patchfeld)", 3: "Licht am Spiegel Gästeklo", 4: "Steckdose Kaminlicht [Dimmer]" },
    S: { 0: "Statusanzeige Rolladen Gästeklo", 2: "5. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Flurlicht neben WZ-Tür / Flurlicht neben Küchentür / Flurlicht neben HWR-Tür", 1: "Flurlicht unten rechts neben HAT unten", 2: "neben Haustür links oben Zusatzbelegung", 3: "Außenlicht neben Haustür oben links", 4: "neben Haustür links oben Zusatzbelegung", 5: "Rolladenschalter Gästeklo auf", 6: "Rolladenschalter Gästeklo zu", 7: "neben Haustür links oben Zusatzbelegung", 8: "Flurlicht (Treppenlicht) rechts neben Haustür oben" },
  },
  '19': {
    room: "erstes von rechts vor Gästeklo",
    hwText: "Dimmer-Modul V93 V1.6",
    A: { 0: "Rolladen HWR auf", 1: "Rolladen HWR zu", 2: "Anschluß Fernseher Flachbild hängend in Flachkanal aus Decke Bad oben", 3: "******** FREI ********", 4: "Deckenlampe Sitzecke Wohnzimmer [Dimmer]" },
    S: { 0: "Rolladenstatusanzeige HWR-Fenster", 2: "6. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Readkontakt WZ-Fenster West", 1: "Readkontakt Gästeklo", 2: "Sabotagekontakt WZ-Fenster West und Gästeklo", 3: "Readkontakt HWR-Fenster", 4: "Sabotagekontakt HWR-Raum (Fenster und Tür)", 5: "Rolladen HWR auf", 6: "Readkontakt Nebeneingangstür HWR", 7: "Rolladen HWR zu" },
  },
  '1A': {
    room: "zweites von rechts vor Gästeklo",
    hwText: "Relais-Modul V72 V1.3",
    A: { 0: "HWR Deckenlampe", 1: "Flurlicht vor Gästeklo ca. 1,2m vor Gästeklo", 2: "Flurlicht vor Garderobe ca. 0,8m in Decke", 3: "Flurlicht vor Küche ca. 1,4m in Decke" },
    S: { 0: "Statusanzeige TOR auf, rechts neben Nebeneingangstür", 2: "Statusanzeige TOR zu, rechts neben Nebeneingangstür" },
    E: { 0: "Readkontakt Haustür", 1: "Sabotagekontakt Haustür", 2: "Garagentor auf rechts neben Nebeneingangstür", 3: "Garagentor zu rechts neben Nebeneingangstür", 4: "Außenlicht neben Nebeneingangstür oben", 5: "Lichtschalter neben Nebeneingangstür oben Zusatzbelegung", 6: "HWR Lichtschalter neben Nebeneingangstür unten", 7: "HWR Lichtschalter neben HWR Tür" },
  },
  '1B': {
    A: { 0: "Ausgang für Lüftermotoransteuerung", 1: "Ausgang für Lüftermotoransteuerung", 2: "Ausgang für Lüftermotoransteuerung", 3: "Ausgang für Lüftermotoransteuerung", 4: "Ausgang für Lüftermotoransteuerung", 5: "Ausgang für Lüftermotoransteuerung", 6: "Ausgang für Lüftermotoransteuerung", 7: "Ausgang für Lüftermotoransteuerung" },
    S: { 0: "7. Ausgang Anzeige Lüftung im Wohnzimmer", 2: "8. Ausgang Anzeige Lüftung im Wohnzimmer" },
    E: { 0: "Sonnenfühler 2-flg. Terrassentür WZ", 1: "Lichtschalter Gästeklo", 2: "Bewegungsmelder Flur unten bei Rauchmelder", 3: "Rauchmelder HWR-Raum Nord-Ost Ecke", 4: "Flurlicht für schräge Wand links neben HAT unten", 5: "2. Lichttaster Gästeklo für Licht an der Wand Spiegelschrank", 6: "Lüftungsschalter WZ 2. Reihe Neben WZ-Tür rechts mehr Luft", 7: "Lüftungsschalter WZ 2. Reihe Neben WZ-Tür links weniger Luft" },
  },
  '1C': {
    A: { 0: "Ausgang für Lüftermotoransteuerung", 1: "Ausgang für Lüftermotoransteuerung", 2: "Ausgang für Lüftermotoransteuerung", 3: "Ausgang für Lüftermotoransteuerung", 4: "Ausgang für Lüftermotoransteuerung", 5: "Ausgang für Lüftermotoransteuerung", 6: "Ausgang für Lüftermotoransteuerung", 7: "Ausgang für Lüftermotoransteuerung" },
  },
  '20': {
    A: { 0: "Kinderzimmer links Rolladen auf", 1: "Kinderzimmer links Rolladen zu", 2: "Flurlicht Treppenaufgang 1. + 2. Kabel", 3: "Steckdose Fensterlaibung rechte Seite Kinderzimmer links", 4: "Deckenlampe Kinderzimmer links [Dimmer]" },
    S: { 0: "Statusanzeige Rolladen Kinderzimmer links" },
    E: { 0: "Rolladen Kinderzimmer links auf, links neben Fenster / Rolladen Kinderzimmer links auf, links neben Eingangstür", 1: "Rolladen Kinderzimmer links zu, links neben Fenster / Rolladen Kinderzimmer links zu, links neben Eingangstür", 2: "Readkontakt Fenster linke Seite Kinderzimmer links", 3: "Readkontakt Fenster rechte Seite Kinderzimmer links", 4: "Sabotagekontakt Kinderzimmer links", 5: "Lichttaster Kinderzimmer links", 6: "Sonnenfühler Kinderzimmer", 7: "alter Rauchmelder Kinderzimmer links" },
  },
  '21': {
    A: { 0: "Kinderzimmer rechts Rolladen auf", 1: "Kinderzimmer rechts Rolladen zu", 2: "Steckdose Fensterlaibung linke Seite Kinderzimmer rechts", 3: "Steckdose Fernseher Nord-Ost-Ecke Kinderzimmer rechts", 4: "Deckenlampe Kinderzimmer rechts [Dimmer]" },
    S: { 0: "Statusanzeige Rolladen Kinderzimmer rechts" },
    E: { 0: "Rolladen Kinderzimmer rechts auf, rechts neben Fenster / Rolladen Kinderzimmer rechts auf, rechts neben Eingangstür", 1: "Rolladen Kinderzimmer rechts zu, rechts neben Fenster / Rolladen Kinderzimmer rechts zu, rechts neben Eingangstür", 2: "Readkontakt Fenster linke Seite Kinderzimmer rechts", 3: "Readkontakt Fenster rechte Seite Kinderzimmer rechts", 4: "Sabotagekontakt Kinderzimmer rechts", 5: "Lichttaster Kinderzimmer rechts", 6: "Sonnenfühler Kinderzimmer", 7: "alter Rauchmelder Kinderzimmer rechts" },
  },
  '22': {
    A: { 0: "Rolladen Gaube links auf", 1: "Rolladen Gaube links zu", 2: "Rolladen Gaube mitte auf", 3: "Rolladen Gaube mitte zu", 4: "Rolladen Gaube rechts auf", 5: "Rolladen Gaube rechts zu", 6: "Steckdose Kinderzimmer links Süd-Ost-Ecke", 7: "Steckdose Arbeitszimmer (Küche oben) neben Fernsehanschluss" },
    S: { 0: "Statusanzeige Rolladen Gaube links", 2: "Statusanzeige Rolladen Gaube mitte" },
    E: { 0: "Rolladen Gaube links auf (unter Lichttaster Arbeitszimmer) / zw. links & mittl. / Fenster in Gaube (Arbeitszimmer)", 1: "Rolladen Gaube links zu (unter Lichttaster Arbeitszimmer) / zw. links & mittl. / Fenster in Gaube (Arbeitszimmer)", 2: "Rolladen Gaube mitte auf (unter Lichttaster Arbeitszimmer) / zw. links & mittl. / Fenster in Gaube (Arbeitszimmer)", 3: "Rolladen Gaube mitte zu (unter Lichttaster Arbeitszimmer) / zw. links & mittl. / Fenster in Gaube (Arbeitszimmer)", 4: "Rolladen Gaube rechts auf (rechts neben Fenster Schlafzimmer)", 5: "Rolladen Gaube rechts zu (rechts neben Fenster Schlafzimmer)", 6: "Lichttaster Arbeitszimmer (Küche oben)", 7: "Lichttaster Flur zwischen den Kinderzimmern / Lichttaster Flur zwischen Schlafzimmer und Bad / Lichttaster Flur an der Tür zum Arbeitszimmer" },
  },
  '23': {
    A: { 0: "Rolladen Schlafzimmer West auf", 1: "Rolladen Schlafzimmer West zu", 4: "Deckenlampe Arbeitszimmer (Küche oben) [Dimmer]" },
    S: { 0: "Statusanzeige Rolladen Gaube rechts (Schlafzimmer)", 1: "Statusanzeige Rolladen Gaube rechts (Schlafzimmer)", 2: "Statusanzeige Rolladen Gaube rechts (Schlafzimmer)" },
    E: { 0: "Rolladen Schlafzimmer (WZ oben) West auf", 1: "Rolladen Schlafzimmer (WZ oben) West zu", 2: "Rolladenzentraltaster Schlafzimmer (WZ oben) auf", 3: "Rolladenzentraltaster Schlafzimmer (WZ oben) zu", 4: "Lichttaster Schlafzimmer (WZ oben)", 5: "Paniktaster Schlafzimmer (WZ oben)", 6: "Flurlicht unterer Schalter oben an der Treppe (links) / Flurlicht unterer Schalter oben an der Treppe (rechts)", 7: "Flurlicht oberer Schalter oben an der Treppe / Flurlicht unterer Schalter oben an der Treppe (rechts)" },
  },
  '24': {
    A: { 0: "Rolladen Bad auf", 1: "Rolladen Bad zu", 2: "Steckdose WZ Nord-West-Ecke", 4: "Deckenlampe Schlafzimmer (WZ oben) [Dimmer]" },
    S: { 0: "Heizkörperanzeige Bad neben Dusche", 1: "Lichttaster HWR oben hinter Bad", 2: "Rolladenstatusanzeige Bad" },
    E: { 0: "Lichttaster HWR oben hinter Bad", 1: "Rolladen Bad auf", 2: "Rolladen Bad zu", 3: "Lichttaster Bad oben an Tür links", 4: "Lichttaster Bad oben an Tür rechts", 5: "Heizkörpertaster neben Dusche", 6: "Lichttaster Abstellraum hinter Bad", 7: "Lichttaster oben Bad an Tür" },
  },
  '30': {
    A: { 0: "Licht in Abstellraum hinter Bad", 1: "Zirkulationspumpe Warmwasser HWR unten", 2: "Licht in Flur", 3: "KABEL zur Verteilerdose West über Badewanne", 4: "KABEL zur Verteilerdose West über Badewanne", 5: "Licht Spiegelschrank Bad", 6: "Heizung Bad am Fenster", 7: "Dimmer Deckenlampe Bad oben (2 Kabel zur Deckenlampe im Bad)" },
    S: { 0: "Statusausgang Rolladentaster am Badfenster", 1: "Zirkulationspumpe WW, Bad oben am Fenster rechts gelbe LED", 2: "Elektroheizung am Badfenster rote LED" },
    E: { 0: "Taster rechts neben Rolladentaster am Fenster", 1: "Taster rechts neben Rolladentaster am Fenster", 2: "Taster rechts neben Rolladentaster am Fenster", 3: "Taster rechts neben Rolladentaster am Fenster", 4: "Taster rechts neben Rolladentaster am Fenster", 5: "Taster rechts neben Rolladentaster am Fenster", 6: "Taster Heizkörper Bad am Fenster", 7: "Rolladen Bad hoch Taster am Fenster", 8: "Rolladen Bad runter Taster am Fenster", 9: "Bad rechts neben Waschbecken + LED über Badewanne", 10: "Bad rechts neben Waschbecken + LED über Badewanne", 11: "Bad rechts neben Waschbecken + LED über Badewanne" },
  },
  '31': {
    A: { 0: "Steckdose unter Dachschrägenfenster", 7: "Dimmer Halogen-Licht in Nische Klo im Bad (2 Kabel zur Deckenlampe im Bad)" },
    S: { 0: "1. LED von links Lüftungsanzeige Flur oben", 1: "2. LED von links Lüftungsanzeige Flur oben", 2: "3. LED von links Lüftungsanzeige Flur oben", 3: "4. LED von links Lüftungsanzeige Flur oben", 4: "5. LED von links Lüftungsanzeige Flur oben", 5: "6. LED von links Lüftungsanzeige Flur oben", 6: "7. LED von links Lüftungsanzeige Flur oben", 7: "8. LED von links Lüftungsanzeige Flur oben" },
    E: { 0: "Lüftungsschalter Flur oben (weniger Lüftung)", 1: "Lüftungsschalter Flur oben (mehr Lüftung)" },
  },
  '40': {
    A: { 0: "Lampe vor Garage zu Kesslers", 1: "Lampe vor Gästezimmer", 2: "Lampe vor Küche", 3: "Lampe vor Wohnzimmer West (Weg zur Terrasse)", 4: "Lampe unter Carport", 5: "Zusatzkabel vor Küche Pallisadensteckdose 1 rechts", 6: "Zusatzkabel vor Küche Pallisadensteckdose 2 links", 7: "Steckdose grosse Terrasse" },
    S: { 0: "Status Brunnen leer", 2: "Status Brunnen 1/4 voll" },
    E: { 0: "Schalter für Steckdose an großer Terrasse (handschriftlich: Lampe unter Carport)", 1: "Schalter für Pumpe ein / aus (handschriftlich: Lampe hinter Garage zum Kompost)", 2: "Schalter für Steckdose Pallisaden 1 (handschriftlich: Haustürlicht)", 3: "Schalter für Steckdose Pallisaden 2 (handschriftlich: Lampe zu Kesslers)", 4: "Terrassenlichtschalter kleine Terrasse (handschriftlich: Licht Gästezimmer)", 5: "Lichtschalter für Licht an Garage hinten (handschriftlich: Licht Küche)", 6: "Tor auf (handschriftlich: Licht Terrasse groß)", 7: "Tor zu (handschriftlich: Weg zur Terrasse)" },
  },
  '41': {
    A: { 0: "Garage hinten Neon zu Kesslers 5-pol.", 1: "Garage hinten Neon zu Kesslers 5-pol.", 2: "Garage vorn mitte 40 Watt", 3: "Garage hinten mitte 40 Watt", 4: "Lampe an Garage hinten zum Kompost [Dimmer]" },
    S: { 0: "Status Brunnen halb voll", 2: "Status Brunnen 3/4 voll" },
    E: { 0: "Füllstand Brunnen Leer", 1: "Füllstand Brunnen 1/4", 2: "Füllstand Brunnen 1/2", 3: "Füllstand Brunnen 3/4", 4: "Füllstand Brunnen voll", 5: "Schalter oben an Garagentor, in Garage hinten neben Eingangstür oben, in Garage vorn links neben Holztür", 6: "Schalter in Garage vorn links neben Holztür, in Garage hinten neben Eingangstür unten", 7: "Bewegungsmelder Gästezimmer noch unter Carport" },
  },
  '42': {
    A: { 0: "Tor auf", 1: "Tor zu", 2: "Strom Garagentorantrieb 5-pol.", 3: "Stromkabel an der Einfahrt unter Stein (nicht angeklemmt)", 4: "Lampen an grosser Terrasse [Dimmer]" },
    S: { 0: "Status Brunnen voll", 2: "Status Strom Pumpe an" },
    E: { 0: "Read Garagentür auf", 1: "Read Garagenfenster Carport auf", 2: "Read Garagenfenster hinten auf", 3: "Sabotagekontakt Garage Fenster / Tür", 4: "Read Garagentor zu", 5: "Read Garagentor auf", 6: "Sabotagekontakt Garagetor", 7: "Schalter in Anschlusskasten Zisterne für Pumpe" },
  },
  '43': {
    A: { 0: "Garage hinten links", 1: "Garage hinten rechts", 2: "Garage vorn links", 3: "Garage vorn rechts", 4: "Lampe an Zisterne (kleine Terrasse) [Dimmer]" },
    S: { 0: "Status Terrassensteckdose ein / Status Steckdose Pallisaden 1 ein" },
    E: { 0: "Bewegungsmelder zur Terrasse", 1: "Bewegungsmelder hinter Garage", 2: "Bewegungsmelder Carport", 3: "Bewegungsmelder vor Gästezimmer aus Kabel zur Terrasse (gelb) oder Carport (grün)", 4: "Lichtschalter vorn neben Tor Neon vorn links", 5: "Lichtschalter vorn neben Tor Neon vorn rechts", 6: "Lichtschalter vorn neben Tor Neon hinten links", 7: "Lichtschalter vorn neben Tor Neon hinten rechts" },
  },
  '44': {
    A: { 0: "an graues Kabel aus 44/I und als Stromversorgung zu den Lampen außen Modul 40/0-5", 1: "Strom aus 43/4 schwarz Kabel I (Legende 1: Licht vor Haustür)", 2: "Strom aus 43/4 braun Kabel I (Legende 2: Licht unter Carport)", 3: "Strom aus 43/4 graues Kabel II (Legende 3: Lampe zu Kesslers)", 4: "Strom aus 43/4 schwarz Kabel II (Legende 4: Lampe vor Gästezimmer)", 5: "Strom aus 43/4 braun Kabel II (Legende 5: Lampe vor Küche)", 6: "graues Kabel III (Legende 6: Terrasse groß)", 7: "schwarzes Kabel III (Legende 7: Weg zur Terrasse)" },
    S: { 0: "Status Steckdose Pallisaden 2 ein" },
    E: { 0: "links neben Tür zur Garage Licht Neon hinten zu Kesslers", 1: "links neben Tür zur Garage Licht Neon hinten zu Roths", 2: "II 9-pol. Kabel zu Schaltern links hinter Garagentür", 3: "II 9-pol. Kabel zu Schaltern links hinter Garagentür", 4: "II 9-pol. Kabel zu Schaltern links hinter Garagentür", 5: "II 9-pol. Kabel zu Schaltern links hinter Garagentür", 6: "II 9-pol. Kabel zu Schaltern links hinter Garagentür", 7: "II 9-pol. Kabel zu Schaltern links hinter Garagentür" },
  },
};
