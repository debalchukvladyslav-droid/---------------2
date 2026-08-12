import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_OCR_SOURCE_HEIGHT,
    MIN_OCR_SOURCE_WIDTH,
    isOCRSourceUsable,
} from '../js/ocr_source_guard.js';

test('OCR rejects storage placeholders before loading Tesseract', () => {
    assert.equal(isOCRSourceUsable(6, 6), false);
    assert.equal(isOCRSourceUsable(9, 5), false);
    assert.equal(isOCRSourceUsable(NaN, 1080), false);
});

test('OCR accepts screenshots at the documented minimum size or larger', () => {
    assert.equal(isOCRSourceUsable(MIN_OCR_SOURCE_WIDTH, MIN_OCR_SOURCE_HEIGHT), true);
    assert.equal(isOCRSourceUsable(1920, 1080), true);
    assert.equal(isOCRSourceUsable(MIN_OCR_SOURCE_WIDTH - 1, 1080), false);
    assert.equal(isOCRSourceUsable(1920, MIN_OCR_SOURCE_HEIGHT - 1), false);
});
