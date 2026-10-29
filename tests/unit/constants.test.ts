import { describe, expect, it } from 'vitest';
import { API_PREFIX, APP_NAME } from '../../src/shared/constants.js';

describe('constants', () => {
  it('exposes the app name and the API prefix', () => {
    expect(APP_NAME).toBe('modpack-studio');
    expect(API_PREFIX).toBe('/api/v1');
  });
});
