import test from 'node:test';
import assert from 'node:assert/strict';
import { INVALID_IMAGE_FORMAT_MESSAGE, isJpegOrPng } from '../js/image_file_validation.js';

test('accepts only JPEG and PNG image MIME types', () => {
    assert.equal(isJpegOrPng({ type: 'image/jpeg' }), true);
    assert.equal(isJpegOrPng({ type: 'image/png' }), true);
    assert.equal(isJpegOrPng({ type: 'image/webp' }), false);
    assert.equal(isJpegOrPng({ type: 'image/gif' }), false);
    assert.equal(isJpegOrPng({ type: 'application/pdf' }), false);
    assert.equal(isJpegOrPng(null), false);
});

test('uses the requested invalid format message', () => {
    assert.equal(INVALID_IMAGE_FORMAT_MESSAGE, 'Невірний формат, перевірте файли');
});
