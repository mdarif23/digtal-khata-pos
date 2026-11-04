-- 0041: Phase 6 advanced expense features.
--
-- expense_templates: recurring expense definitions. Generation is a
-- transactional state machine — the same transaction that inserts the
-- expense advances next_generation_date (row-locked), so a retry can never
-- produce a duplicate period. Generated expenses are ALWAYS created unpaid;
-- nothing in this schema can mark them settled.
--
-- expense_budgets: monthly spending plans per scope. category_id/location_id
-- NULL means "all categories/locations" — the unique index coalesces NULLs
-- to 0 because plain UNIQUE treats NULLs as distinct.

CREATE TABLE expense_templates (
    id SERIAL PRIMARY KEY,
    business_id integer NOT NULL REFERENCES businesses (id),
    title varchar(255) NOT NULL,
    amount numeric(10, 2) NOT NULL,
    category_id integer,
    payment_method varchar(50) NOT NULL,
    payee varchar(150),
    note text,
    location_id integer,
    channel sale_channel,
    frequency varchar(10) NOT NULL,
    start_date date NOT NULL,
    end_date date,
    next_generation_date date NOT NULL,
    last_generated_date date,
    is_active boolean NOT NULL DEFAULT true,
    created_by integer,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT expense_templates_amount_check CHECK (amount > (0)::numeric),
    CONSTRAINT expense_templates_frequency_check CHECK (
        frequency::text = ANY ((ARRAY['weekly'::character varying, 'monthly'::character varying, 'yearly'::character varying])::text[])
    ),
    CONSTRAINT expense_templates_payment_method_check CHECK (
        (payment_method)::text = ANY ((ARRAY['Cash'::character varying, 'Mobile'::character varying, 'Card'::character varying])::text[])
    )
);

ALTER TABLE expense_templates ADD CONSTRAINT expense_templates_category_business_fkey FOREIGN KEY (category_id, business_id) REFERENCES expense_categories (id, business_id);
ALTER TABLE expense_templates ADD CONSTRAINT expense_templates_location_business_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id);
ALTER TABLE expense_templates ADD CONSTRAINT expense_templates_created_by_users_fk FOREIGN KEY (created_by) REFERENCES users (id);

CREATE INDEX expense_templates_business_due_idx ON expense_templates (business_id, next_generation_date);
CREATE UNIQUE INDEX expense_templates_id_business_uq ON expense_templates (id, business_id);

CREATE TABLE expense_budgets (
    id SERIAL PRIMARY KEY,
    business_id integer NOT NULL REFERENCES businesses (id),
    category_id integer,
    location_id integer,
    month date NOT NULL,
    amount numeric(12, 2) NOT NULL,
    created_by integer,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT expense_budgets_amount_check CHECK (amount > (0)::numeric),
    CONSTRAINT expense_budgets_month_check CHECK (month = date_trunc('month', month)::date)
);

ALTER TABLE expense_budgets ADD CONSTRAINT expense_budgets_category_business_fkey FOREIGN KEY (category_id, business_id) REFERENCES expense_categories (id, business_id);
ALTER TABLE expense_budgets ADD CONSTRAINT expense_budgets_location_business_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id);
ALTER TABLE expense_budgets ADD CONSTRAINT expense_budgets_created_by_users_fk FOREIGN KEY (created_by) REFERENCES users (id);

-- One budget per scope+month; COALESCE folds the "all categories/locations"
-- NULL sentinels into the key.
CREATE UNIQUE INDEX expense_budgets_scope_month_unique ON expense_budgets (
    business_id,
    COALESCE(category_id, 0),
    COALESCE(location_id, 0),
    month
);
CREATE INDEX expense_budgets_business_month_idx ON expense_budgets (business_id, month);
