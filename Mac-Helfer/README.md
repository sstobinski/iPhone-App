# Mac-Helfer 0.1.13

Dieser Ordner enthält den vollständigen Mac-Teil des Serato Companion: native Bildschirmaufnahme, lokale Bereichserkennung, JPEG-Übertragung und separater Metadatenkanal für Titel, Interpret und BPM. Die native Aufnahme und die Bilderkennung entsprechen der zuvor getesteten Fassung; die neue Bewegungsdiagnose ergänzt den Statuskanal und das Messprotokoll.

**Start-Fenster-Test.command** startet mit Aufnahmeziel 60 FPS. **Start-30-FPS.command** ist der Vergleichsstart. Unter macOS muss Node.js ab Version 22 installiert sein; die Apple-Compilerwerkzeuge bauen den Swift-Helfer beim ersten Start. Die angefragte Bildschirmaufnahmeberechtigung erlauben. Es wird kein Ton aufgenommen.

Die iPhone-App liegt im Hauptordner dieses Repositories. Dort **WaveCompanion.xcodeproj** öffnen und die vorhandenen Signing-Einstellungen verwenden. Den aktuellen QR-Code der Mac-Einrichtung in der iPhone-App scannen. Für die neue getrennte Bewegungs-FPS-Messung werden der neue Helfer und der neue iPhone-Code gemeinsam benötigt.

Beenden mit **q und Enter** oder **Strg+C**. Dabei wird **window-report.json** in diesem Ordner erzeugt. Der Bericht wird von Git ignoriert und enthält technische Zähler, keine Songtitel, Interpreten, Musikpfade, Bilder oder Zugangsschlüssel.

**npm test** führt 150 Node-Tests aus. **npm run demo** startet einen synthetischen Demo-Betrieb ohne echte Serato-Aufnahme. Die weitergehenden Prüfgrenzen stehen in **VALIDIERUNG.md**, Lizenzen in **THIRD-PARTY-NOTICES.md**.
