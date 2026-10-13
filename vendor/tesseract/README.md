Tesseract.js 5.1.1 and tesseract.js-core 5.1.1, distributed under Apache-2.0.

The browser bundle and worker come from the official npm package `tesseract.js@5.1.1`.
The two embedded-WASM LSTM cores come from `tesseract.js-core@5.1.1`.
OCR uses OEM 1 (LSTM only); both SIMD and non-SIMD devices are supported.
Each `.wasm.js` file embeds its WASM binary and does not need a separate `.wasm` file.

English language data is `@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz`.
All OCR assets are served from the same origin, including language data.
