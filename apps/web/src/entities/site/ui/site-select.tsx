'use client';

import type { ComponentProps } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import type { Site } from '../model/types';

/** Other props reach the trigger, so a form control can give it its id and aria attributes. */
interface SiteSelectProps extends Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'onChange'> {
  sites: readonly Site[];
  value: string | undefined;
  onChange: (siteId: string) => void;
  placeholder?: string;
}

export function SiteSelect({ sites, value, onChange, placeholder = 'Choose a site', ...trigger }: SiteSelectProps) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger aria-label="Site" {...trigger}>
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
