import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorPage } from '@/app/error';

describe('error page', () => {
  it('explains, offers a retry and a way back, and keeps the details out of the page', () => {
    const html = renderToStaticMarkup(<ErrorPage error={new Error('secret stack detail')} reset={() => undefined} />);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('kept on this device');
    expect(html).toContain('Try again');
    expect(html).toContain('href="/"');
    expect(html).not.toContain('secret stack detail');
  });
});
