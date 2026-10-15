import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../src/bot/platforms/index.js';
import { parseZoomUrl, zoomWebClientUrl } from '../src/bot/platforms/zoom.js';

test('detectPlatform routes links to the right adapter', () => {
  assert.equal(detectPlatform('https://meet.google.com/abc-defg-hij')?.name, 'meet');
  assert.equal(detectPlatform('https://zoom.us/j/1234567890?pwd=abc')?.name, 'zoom');
  assert.equal(detectPlatform('https://us05web.zoom.us/j/1234567890')?.name, 'zoom');
  assert.equal(detectPlatform('https://acme.zoom.us/j/98765432101')?.name, 'zoom');
  assert.equal(detectPlatform('https://zoom.us.evil.com/j/1234567890'), null);
  assert.equal(detectPlatform('https://teams.microsoft.com/l/meetup-join/x'), null);
  assert.equal(detectPlatform('not a url'), null);
});

test('Zoom links become web-client URLs and keep the passcode token', () => {
  assert.equal(zoomWebClientUrl('https://zoom.us/j/1234567890?pwd=AbC.1'), 'https://app.zoom.us/wc/join/1234567890?pwd=AbC.1');
  assert.equal(zoomWebClientUrl('https://us05web.zoom.us/j/1234567890'), 'https://app.zoom.us/wc/join/1234567890');
  assert.equal(zoomWebClientUrl('https://acme.zoom.us/j/98765432101?pwd=x'), 'https://acme.zoom.us/wc/join/98765432101?pwd=x');
  assert.equal(zoomWebClientUrl('https://app.zoom.us/wc/1234567890/join?pwd=x'), 'https://app.zoom.us/wc/join/1234567890?pwd=x');
  assert.equal(parseZoomUrl('https://zoom.us/wc/join/1234567890').id, '1234567890');
});

test('Zoom meeting ids are used in folder names', () => {
  assert.equal(detectPlatform('https://zoom.us/j/1234567890')?.meetingId('https://zoom.us/j/1234567890'), 'zoom-1234567890');
  assert.equal(detectPlatform('https://meet.google.com/abc-defg-hij')?.meetingId('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
});
