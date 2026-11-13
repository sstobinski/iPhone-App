# Serato Companion – Platten und Wellenformen

Die neue Ansicht zeigt **beide Serato-Platten oben**, die **Wellenformen in der Mitte** und **Titel sowie Interpret unten**. BPM, Pitch und Laufzeiten stehen im Originalbild der jeweiligen Platte. Die bisherige zusätzliche BPM-Zahl aus dem Statuskanal entfällt.

Das Repository enthält das native iPhone-Projekt und den **Mac-Helfer**. Funktionsstand: **0.2.0, Platten-Prototyp**. Die vorhandenen Signing-Einstellungen und das Xcode-Scheme bleiben erhalten.

## Starten und prüfen

1. Den vorherigen Mac-Helfer beenden. **Mac-Helfer/Start-Fenster-Test.command** aus diesem Branch starten.
2. In Serato die Zwei-Deck-Ansicht mit sichtbaren Platten und Wellenformen öffnen. Die automatische Erkennung berücksichtigt zwei kreisförmige Plattenanzeigen neben den Wellenformen; sie ist anhand geladener und leerer vertikaler sowie geladener horizontaler Vorlagen geprüft. Andere Profile können weitere Anpassungen erfordern.
3. **WaveCompanion.xcodeproj** öffnen oder **Start-iPhone-App.command** starten. Das vorhandene Personal Team und den eigenen Bundle Identifier verwenden. Eigenes iPhone wählen und **Run** drücken.
4. In der iPhone-App den neuen Mac-QR-Code scannen. Im Hochformat Seratos vertikale Ansicht verwenden; Querformat ist für die horizontale Ansicht gedacht.
5. Beide Tracks abspielen, einzeln und gemeinsam entladen, wieder laden und die Ansicht wechseln. Prüfen, ob die korrekten Platten über der Wellenform stehen und Titel/Interpret darunter erscheinen. Bei nicht erkannten Platten bleibt die Wellenform sichtbar; die App zeigt einen entsprechenden Hinweis.
6. Den Mac-Helfer mit **q und Enter** beenden. Die **Mac-Helfer/window-report.json** enthält jetzt auch `platterCropsApplied` und `lastPlatterCount`. Berichte werden von Git ignoriert.

Mac-Helfer und iPhone-App für diese Ansicht gemeinsam aktualisieren. Ältere iPhone-Clients können die neuen Teilbereiche noch nicht aufteilen. Die neue iPhone-App kann mit einem älteren Helfer weiterhin die Wellenform anzeigen, erhält dann aber keine Plattenbereiche.

## Wie die Bildanzeige arbeitet

Der Mac erkennt den Wellenformausschnitt und die zwei Plattenbereiche. Nach zwei übereinstimmenden Analysen wird ein gemeinsamer rechteckiger Aufnahmeausschnitt freigegeben, der diese Bereiche enthält. Zwischenräume mit Serato-Bedienelementen gehören technisch zu diesem JPEG, werden auf dem iPhone jedoch nicht angezeigt. Die Trackbibliothek wird nicht als Plattenansicht ausgewählt.

Das iPhone dekodiert ein JPEG und zeigt daraus drei Teilbilder mit UIKit an. Alle drei stammen aus demselben Aufnahmebild und gehören zur selben Geometrie-/Ausschnittkennung. Eine Änderung verwirft die alte Zuordnung. Es gibt keine drei unabhängig laufenden Bildströme und keinen selbst berechneten Audio-Wellenform-Renderer. Seratos Cue-Farben, Stems-Darstellung und Platteninformationen bleiben Teil des Originalbildes.

Der separate Statuskanal liefert für die sichtbaren Trackkarten nur Titel und Interpret. Positions-/Geschwindigkeitsdaten werden weiterhin für die vorhandene Bewegungs-FPS-Diagnose verwendet. BPM wird nicht mehr als eigenes Trackdatenfeld an die Anzeige geschickt.

Die native Mac-Aufnahme und JPEG-Qualität bleiben unverändert. Der größere gemeinsame Ausschnitt enthält mehr Pixel; die tatsächlich erreichte Bildrate mit Platten muss auf dem Gerät gemessen werden. Die Performance-Optimierung ist nicht Bestandteil dieses Funktionsschritts.

## Voraussetzungen und Prüfungen

- Mac: macOS mit ScreenCaptureKit, Node.js ab Version 22, Apple-Compilerwerkzeuge und Bildschirmaufnahmeberechtigung. Es wird kein Ton aufgenommen.
- iPhone: Xcode-Projekt mit eigenem Personal Team auf dem Gerät ausführen. Die kostenlose Apple-ID reicht für eigene Tests; Signierung ist üblicherweise sieben Tage gültig.
- **cd Mac-Helfer && npm test**: 157 Node-Tests für Transport, Bilderkennung, Metadaten, gemeinsame Bildbereiche und den Schutz vor alten/ungeprüften Frames.
- **Product → Test / Cmd+U** in Xcode: zehn native XCTest-Fälle für Protokoll, Bildbereiche, Abruf und Bewegungszähler. Diese nativen Tests sind hier noch nicht ausgeführt.
- Die Swift-Syntax wird unter Linux geprüft. Web-Anzeige und echte Vorlagen werden separat geprüft; das ersetzt keinen nativen iPhone-Build oder Gerätetest. Xcode und Apple-iOS-SDKs stehen hier nicht zur Verfügung.

Weitere technische Grenzen und der Prüfstand stehen in **Mac-Helfer/VALIDIERUNG.md**, Drittanbieterhinweise in **Mac-Helfer/THIRD-PARTY-NOTICES.md**. Die Serato-Statusanbindung ist inoffiziell und keine öffentliche SDK-Zusage.
