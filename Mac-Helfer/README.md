# Mac-Helfer 0.2.0 – Platten-Prototyp

**Start-Fenster-Test.command** startet die lokale Einrichtung mit Aufnahmeziel 60 FPS. **Start-30-FPS.command** bleibt für einen späteren Vergleich verfügbar. Node.js ab Version 22 und Apple-Compilerwerkzeuge müssen installiert sein; die Bildschirmaufnahmeberechtigung ist erforderlich. Es wird kein Ton aufgenommen.

Die Erkennung sucht neben den Wellenformen zwei kreisförmige Serato-Platten. Ein gemeinsamer Ausschnitt liefert die Bilder für die neue iPhone-Ansicht. Deshalb auch die iPhone-App aus demselben Branch bauen. Das ursprüngliche native Aufnahmeprogramm und seine JPEG-Einstellungen sind unverändert.

Das Xcode-Projekt liegt im Hauptordner des Repositories. Vorhandenes Personal Team und Bundle Identifier weiterverwenden. Nach dem Start der App den neuen Mac-QR-Code scannen. Titel und Interpret werden separat empfangen; die doppelte BPM-Anzeige entfällt.

Beenden mit **q und Enter** oder **Strg+C**. Dabei entsteht **window-report.json** in diesem Ordner. Der Bericht enthält keine Songtitel, Interpreten, Musikpfade, Bilder oder Zugangsschlüssel und wird von Git ignoriert. Neu sind die Zähler **platterCropsApplied** und **lastPlatterCount**.

**npm test** prüft die Node-Komponenten. **npm run demo** startet synthetische Wellenformen ohne echte Serato-Aufnahme; dort werden keine echten Platten erwartet. Prüfgrenzen stehen in **VALIDIERUNG.md**, Lizenzen in **THIRD-PARTY-NOTICES.md**.
