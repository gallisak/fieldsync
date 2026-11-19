import { renderToStaticMarkup } from 'react-dom/server';
import { SiteSelect } from '@/entities/site';

const sites = [
  { id: 's1', name: 'North yard' },
  { id: 's2', name: 'South yard' },
];

describe('site UI', () => {
  it('shows the placeholder until a site is chosen', () => {
    const empty = renderToStaticMarkup(<SiteSelect sites={sites} value={undefined} onChange={() => undefined} />);
    expect(empty).toContain('Choose a site');
    expect(empty).toContain('data-placeholder');

    const custom = renderToStaticMarkup(
      <SiteSelect sites={sites} value={undefined} onChange={() => undefined} placeholder="All sites" />,
    );
    expect(custom).toContain('All sites');

    const chosen = renderToStaticMarkup(<SiteSelect sites={sites} value="s2" onChange={() => undefined} />);
    expect(chosen).not.toContain('Choose a site');
    expect(chosen).not.toContain('data-placeholder');
  });
});
