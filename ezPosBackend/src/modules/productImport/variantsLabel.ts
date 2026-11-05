import { sql } from "drizzle-orm";

/** ", "-joined option-value label for a variant row alias (raw-SQL queries). */
export function variantOptionsLabelSubquery(variantAlias: string) {
  const v = sql.raw(variantAlias);
  return sql`(SELECT string_agg(vo.value, ', ' ORDER BY vv.option_id)
    FROM variant_values vv
    INNER JOIN variant_options vo ON vo.id = vv.option_id
    WHERE vv.variant_id = ${v}.id)`;
}
