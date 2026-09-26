# rubenbarels.nl

Persoonlijke pagina: één statische HTML-pagina (`index.html`, `styles.css`) met een
weer- en klokintegratie in `script.js`. Er is geen build-stap — de bestanden worden
zoals ze zijn geserveerd.

## Controleren

```bash
npm ci            # eenmalig, installeert de ontwikkel-tools
npm run lint      # eslint
npm run typecheck # tsc --noEmit (strikt, controleert script.js)
npm run coverage  # draait de tests door c8: regeltotaal + ondergrens uit .c8rc.json
npm test          # alleen de tests, zonder dekkingsmeting
```

`npm run check` doet lint, typecheck en coverage achter elkaar.

* **Dekking.** `npm run coverage` print het regeltotaal en faalt onder de
  ondergrens in `.c8rc.json`. Het rapport `coverage/lcov.info` wordt meegeleverd
  in git: een regel in een CI-log verloopt, een vastgelegd rapport blijft
  leesbaar vanaf `main`. CI weigert een rapport dat niet meer bij de bron hoort
  (`git diff --exit-code -- coverage/lcov.info`).
* **Tests.** `tests/script.test.mjs` laadt de echte `index.html` in jsdom en
  draait `script.js` in een geïsoleerde context met eigen timers, `fetch`,
  `navigator` en klok, zodat elke weersoort, elke terugvaloptie en elk
  tijdstip van de dag getest wordt. `tests/tooling.test.mjs` bewaakt de
  hulpmiddelen hierboven, zodat ze niet stil verdwijnen.

## CI

`.github/workflows/ci.yml` draait op elke pull request: `npm ci`, `eslint`, `tsc
--noEmit`, de coverage-run met ondergrens en de actualiteitscontrole op het
meegeleverde lcov-rapport. Node is vastgezet op de patchversie waarmee
`coverage/lcov.info` is gemaakt, zodat de cijfers reproduceerbaar blijven.
`.github/workflows/deploy.yml` deployt `main` naar Coolify.
