Projekt: piaskraft-stock-sync (synchronizacja stanów zewnętrzny feed → PrestaShop)

1. Cel skryptu

Skrypt piaskraft-stock-sync służy do cyklicznej aktualizacji stanów magazynowych w sklepie PrestaShop na podstawie dwóch feedów produktowych dostawcy:

- Feed CENEO (XML) – główne źródło stanów magazynowych (dokładna ilość).
- Feed Google (XML) – źródło zapasowe, używane tylko wtedy, gdy dany EAN nie występuje w feedzie CENEO (informacja typu in_stock / brak).

Skrypt:
- pobiera listę produktów z PrestaShop (id, EAN),
- pobiera aktualne stany magazynowe z PrestaShop (stock_availables),
- pobiera feed CENEO oraz Google,
- oblicza docelowy stan magazynowy w sklepie według zadanej logiki,
- może działać w trybie DRY-RUN (bez zmian) lub w trybie produkcyjnym (aktualizacja stock_availables przez API).


2. Logika biznesowa stanów

Dla każdego produktu w PrestaShop, który ma ustawiony EAN:

1) Próba dopasowania po EAN w feedzie CENEO:
   - Jeżeli EAN występuje w CENEO:
     • pobieramy pole @_stock (ilość w magazynie dostawcy),
     • liczymy docelowy stan sklepu:
       - jeśli @_stock <= 2 → stan sklepu = 0
       - jeśli @_stock > 2  → stan sklepu = @_stock - 2
     • to źródło ma najwyższy priorytet (Google jest ignorowane, jeśli CENEO istnieje).

2) Jeśli EAN nie występuje w CENEO, sprawdzany jest feed Google:
   - Jeżeli EAN występuje w Google:
     • jeśli g:availability = "in_stock" → stan sklepu = GOOGLE_FALLBACK_QTY (np. 2)
     • w innym przypadku → stan sklepu = 0

3) Jeśli EAN nie występuje ani w CENEO, ani w Google:
   - stan sklepu = 0 (produkt traktowany jako niedostępny).

Skrypt porównuje bieżący stan produktu w PrestaShop z wyliczonym stanem docelowym. Aktualizowane są tylko te rekordy, w których wartości się różnią.


3. Wymagania techniczne

- Node.js w wersji co najmniej 18.x
- Dostęp do serwera API PrestaShop (URL + klucz API z uprawnieniami do:
  - products: GET
  - stock_availables: GET, PUT)
- Dostęp do plików feedów XML:

  - CENEO: https://mjwtools.com/xml/ceneo.xml
  - Google: https://mjwtools.com/xml/google_products.xml

- System:
  - lokalnie: dowolny (Windows / Linux / macOS) do developmentu,
  - produkcyjnie: VPS z Linux (dla crona co 15/30 minut).


4. Struktura projektu

Przykładowa struktura repozytorium:

- index.js              – główny skrypt synchronizacji
- check-ean.js          – skrypt diagnostyczny do sprawdzania jednego EAN
- package.json          – zależności (axios, fast-xml-parser, dotenv itd.)
- .env                  – konfiguracja środowiskowa (URL Presta, klucz API, feedy, flagi)
- README / dokumentacja – ta instrukcja

Instalacja zależności:

  npm install


5. Konfiguracja środowiska (.env)

W katalogu projektu należy utworzyć plik .env o następującej strukturze:

PRESTA_URL=https://piaskraft.com
PRESTA_API_KEY=KLUCZ_API_PRESTA

FEED_URL=https://mjwtools.com/xml/ceneo.xml
GOOGLE_FEED_URL=https://mjwtools.com/xml/google_products.xml

# Domyślnie tryb DRY-RUN (bez zmian w PrestaShop)
APPLY_CHANGES=false

# Limit aktualizacji w jednym uruchomieniu (gdy APPLY_CHANGES=true)
MAX_UPDATES=300

# Liczba sztuk do ustawienia, gdy Google podaje "in_stock"
GOOGLE_FALLBACK_QTY=2

# Lista EAN-ów, które wolno aktualizować (do testów)
# Pusta wartość oznacza: aktualizuj wszystkie różniące się produkty
ALLOWED_EANS=


Opis kluczowych zmiennych:

- PRESTA_URL – adres sklepu PrestaShop, bez ukośnika na końcu.
- PRESTA_API_KEY – klucz Webservice wygenerowany w panelu PrestaShop.
- FEED_URL – URL feedu CENEO z pełnymi informacjami o stanach.
- GOOGLE_FEED_URL – URL feedu Google z informacją o dostępności in_stock.
- APPLY_CHANGES – flaga:
  • false → tryb DRY-RUN (skrypt nic nie zapisuje do Presty, tylko loguje, co by zmienił),
  • true  → tryb produkcyjny (skrypt wysyła zmiany do PrestaShop).
- MAX_UPDATES – maksymalna liczba rekordów, które mogą zostać zaktualizowane w jednym przebiegu.
- GOOGLE_FALLBACK_QTY – ilość sztuk ustawiana, gdy produkt jest in_stock w Google, ale nie istnieje w CENEO.
- ALLOWED_EANS – lista EAN-ów (oddzielona przecinkami), które wolno aktualizować w danym uruchomieniu (mechanizm bezpiecznego testu).


6. Tryb DRY-RUN – test globalny (bez zmian w PrestaShop)

Na początek zawsze zaleca się uruchomienie skryptu w trybie DRY-RUN, który niczego nie zapisuje, a jedynie wypisuje podsumowanie w logach.

Konfiguracja w .env:

APPLY_CHANGES=false
ALLOWED_EANS=


Uruchomienie:

  npm run dev


Skrypt:
- pobierze dane z PrestaShop,
- pobierze feed CENEO i Google,
- policzy wszystkie różnice stanów,
- wypisze podsumowanie, m.in.:
  - ile produktów wymaga zmiany,
  - ile produktów korzysta z CENEO, ile z Google,
  - ile produktów w ogóle nie ma źródła,
  - przykładowe zmiany.

W tym trybie nic nie jest zmieniane w PrestaShop.


7. Test jednego konkretnego produktu (bezpośrednio w feedach) – check-ean.js

Do analizy pojedynczego produktu (konkretnego EAN) służy pomocniczy skrypt check-ean.js. Sprawdza on:

- powiązany produkt i stan w PrestaShop,
- stan w feedzie CENEO (dokładny @_stock i wyliczony stan sklepu),
- dostępność w feedzie Google (in_stock / brak).

Konfiguracja w .env:

TEST_EAN=KONKRETNY_EAN


Uruchomienie:

  node check-ean.js


W konsoli pojawi się m.in.:

- ID produktu i EAN w PrestaShop,
- bieżący stan quantity,
- wpis w CENEO (jeśli istnieje),
- wyliczony docelowy stan według logiki (po -2 sztuki, nie mniej niż 0),
- wpis w Google: title, availability, price (jeśli istnieje).


8. Test produkcyjny na jednym EAN – kontrolowana aktualizacja

Przed włączeniem pełnej synchronizacji zaleca się wykonanie kontrolowanego testu aktualizacji tylko jednego produktu.

Konfiguracja w .env (przykład):

APPLY_CHANGES=true
ALLOWED_EANS=5901867202543
MAX_UPDATES=1


Uruchomienie:

  npm run dev


Przebieg:

- Skrypt policzy pełną listę różnic (toChange),
- Następnie przefiltruje ją po ALLOWED_EANS – w tym przykładzie zostanie tylko jeden EAN,
- Do funkcji aktualizującej (applyChanges) trafi wyłącznie przefiltrowana lista finalToChange,
- Z uwagi na MAX_UPDATES=1 zostanie przetworzony maksymalnie jeden rekord.

Log będzie zawierał linię:

FILTR EAN: ALLOWED_EANS=5901867202543 -> do aktualizacji trafi 1 pozycji.

oraz informację o faktycznej zmianie:

OK: produkt 1368 (EAN 5901867202543) qty 341 -> 307


Po teście można w panelu PrestaShop zweryfikować, czy stan został ustawiony na wartość docelową. Następnie zaleca się przywrócenie:

APPLY_CHANGES=false
ALLOWED_EANS=


9. Tryb produkcyjny – pełna synchronizacja

Po zaakceptowaniu logiki i przeprowadzeniu testów pojedynczych produktów można włączyć pełną synchronizację.

Przykładowa konfiguracja .env dla środowiska produkcyjnego:

PRESTA_URL=https://piaskraft.com
PRESTA_API_KEY=KLUCZ_API_PRESTA

FEED_URL=https://mjwtools.com/xml/ceneo.xml
GOOGLE_FEED_URL=https://mjwtools.com/xml/google_products.xml

APPLY_CHANGES=true
ALLOWED_EANS=
MAX_UPDATES=300
GOOGLE_FALLBACK_QTY=2


- APPLY_CHANGES=true – włącza wysyłanie zmian do PrestaShop,
- ALLOWED_EANS puste – dopuszczamy aktualizację wszystkich produktów, które mają różne stany,
- MAX_UPDATES=300 – ogranicza liczbę aktualizacji w jednym uruchomieniu (można dostosować).

Uruchomienie ręczne:

  npm run dev


10. Automatyzacja na VPS (cron co 15 lub 30 minut)

Docelowo skrypt ma działać na serwerze VPS (Linux) jako zadanie cykliczne. Poniżej przykładowa konfiguracja:

Założenia:

- Projekt znajduje się w katalogu:
  /var/www/piaskraft-stock-sync
- Node.js zainstalowany globalnie (np. /usr/bin/node).

A. Skrypt uruchomieniowy (opcjonalnie, dla przejrzystości)

W katalogu projektu stworzyć plik sync.sh:

#!/bin/bash
cd /var/www/piaskraft-stock-sync
/usr/bin/node ./index.js >> sync.log 2>&1


Nadać prawa wykonywalne:

  chmod +x /var/www/piaskraft-stock-sync/sync.sh


B. Konfiguracja crona – uruchamianie co 15 minut

Edytować crontab:

  crontab -e


Dodać wpis:

  */15 * * * * /var/www/piaskraft-stock-sync/sync.sh


Skrypt index.js będzie uruchamiany co 15 minut, a logi dopisywane do pliku sync.log w katalogu projektu.


C. Konfiguracja crona – uruchamianie co 30 minut

Analogicznie, dla interwału 30 minut:

  */30 * * * * /var/www/piaskraft-stock-sync/sync.sh


Ważne uwagi operacyjne:

- Przed włączeniem crona należy upewnić się, że w .env dla produkcji ustawiono:
  - APPLY_CHANGES=true,
  - ALLOWED_EANS puste (chyba że celowo ograniczamy zakres),
  - poprawną ścieżkę PRESTA_URL i klucz PRESTA_API_KEY.
- Warto okresowo sprawdzać logi w pliku sync.log (wyszukiwać ewentualne błędy HTTP, problem z XML, timeouty itp.).


11. Bezpieczeństwo i dobre praktyki

- Zawsze zaczynać od DRY-RUN (APPLY_CHANGES=false) po każdej zmianie w kodzie lub konfiguracji.
- Nowe produkty / edge-case’y testować najpierw za pomocą:
  - check-ean.js,
  - ALLOWED_EANS + pojedynczy test z APPLY_CHANGES=true.
- Klucza PRESTA_API_KEY nie commitować do repozytorium – powinien być przechowywany wyłącznie w .env na serwerze.
- W razie potrzeby można zmniejszyć MAX_UPDATES, aby ograniczyć ryzyko masowych zmian w przypadku nietypowego błędu po stronie feedu.
