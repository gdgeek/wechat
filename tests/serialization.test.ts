import { describe, expect, it } from 'vitest';

describe('Yii XML object metadata', () => {
  it('keeps class names in XML without changing public JSON fields', async () => {
    const api: any = await import('../src/core/serialization').catch(() => ({}));
    expect(api.yiiObject).toBeTypeOf('function');
    const expression = api.yiiObject('Expression', { expression: 'NOW()', params: [] });
    expect(JSON.stringify(expression)).toBe('{"expression":"NOW()","params":[]}');
    expect(api.xmlResponse({ updated_at: expression })).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<response><updated_at><Expression><expression>NOW()</expression><params/></Expression></updated_at></response>\n');
    expect(api.xmlResponse(api.yiiObject('Application', {}))).toContain('<response><Application/></response>');
  });
  it('writes nullable scalars, arrays and escaped text as DOM text nodes', async () => {
    const api: any = await import('../src/core/serialization').catch(() => ({}));
    expect(api.xmlResponse).toBeTypeOf('function');
    expect(api.xmlResponse({ empty: null, text: '"<&\'"', flags: [true, false], zero: 0 })).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<response><empty></empty><text>"&lt;&amp;\'"</text><flags><item>true</item><item>false</item></flags><zero>0</zero></response>\n');
    expect(api.xmlResponse(null)).toBe('');
  });
});
