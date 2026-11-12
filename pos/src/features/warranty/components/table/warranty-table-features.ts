import { tableFeatures } from "@tanstack/react-table";

/**
 * New in v9: declare the features this table uses — anything you don't
 * register is tree-shaken out of the bundle. Warranty tables are fully
 * server-paginated/filtered, so only the core row model is needed.
 */
export const warrantyTableFeatures = tableFeatures({});

// Pass this as the first generic argument to `ColumnDef`, `Column`, `Table`,
// and `Row` so each type knows which feature APIs are available.
export type WarrantyTableFeatures = typeof warrantyTableFeatures;
