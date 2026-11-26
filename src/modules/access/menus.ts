export const MENUS = [
  { key: 'dashboard', label: 'Dashboard', hasEdit: false, superOnly: false },
  { key: 'master-cable', label: 'Master Cable System', hasEdit: true, superOnly: false },
  { key: 'upload-kmz', label: 'Upload KMZ', hasEdit: false, superOnly: false },
  { key: 'map', label: 'Map', hasEdit: false, superOnly: false },
  { key: 'master-user', label: 'Master User', hasEdit: false, superOnly: true },
  { key: 'master-so', label: 'Master SO', hasEdit: true, superOnly: true },
  { key: 'master-so', label: 'Master SO', hasEdit: true, superOnly: true },
  { key: 'serpo-section', label: 'Serpo Section', hasEdit: true, superOnly: true },
  { key: 'master-customer', label: 'Master Customer', hasEdit: true, superOnly: true },
  // ticket types (replace the old 'transaction' menu)
  { key: 'preventive-maintenance', label: 'Preventive Maintenance', hasEdit: true, superOnly: false },
  { key: 'corrective-maintenance', label: 'Corrective Maintenance', hasEdit: true, superOnly: false },
  { key: 'degraded', label: 'Degraded', hasEdit: true, superOnly: false },
  { key: 'master-ticket', label: 'Master Ticket', hasEdit: true, superOnly: true },
  { key: 'master-assets', label: 'Master Assets', hasEdit: true, superOnly: true },
] as const

export type MenuKey = (typeof MENUS)[number]['key']

export const MENU_BY_KEY = new Map<string, (typeof MENUS)[number]>(MENUS.map((m) => [m.key, m]))