'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import type { Site } from '../model/types';

interface SiteSelectProps {
  sites: readonly Site[];
  value: string | undefined;
  onChange: (siteId: string) => void;
  placeholder?: string;
}

export function SiteSelect({ sites, value, onChange, placeholder = 'Choose a site' }: SiteSelectProps) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger aria-label="Site">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {sites.map((site) => (
          <SelectItem key={site.id} value={site.id}>
            {site.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
