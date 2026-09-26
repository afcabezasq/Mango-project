-- Migration: create_organization_secrets_table
-- Date: 2026-09-26

-- 1. Create table for organization secrets and configuration
CREATE TABLE IF NOT EXISTS public.organization_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    description TEXT,
    is_secret BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Comments
COMMENT ON TABLE public.organization_secrets IS 'Stores organization-level secrets and configuration for Mango Agent';
COMMENT ON COLUMN public.organization_secrets.key IS 'Configuration key name';
COMMENT ON COLUMN public.organization_secrets.value IS 'Secret or configuration value';
COMMENT ON COLUMN public.organization_secrets.description IS 'Description of the secret or config parameter';
COMMENT ON COLUMN public.organization_secrets.is_secret IS 'Whether the value contains sensitive credentials';

-- 3. Index
CREATE INDEX IF NOT EXISTS idx_org_secrets_key ON public.organization_secrets (key);

-- 4. Trigger
DROP TRIGGER IF EXISTS trigger_org_secrets_updated_at ON public.organization_secrets;
CREATE TRIGGER trigger_org_secrets_updated_at
    BEFORE UPDATE ON public.organization_secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.organization_secrets ENABLE ROW LEVEL SECURITY;

-- 6. Grant schema access to roles
GRANT ALL ON TABLE public.organization_secrets TO authenticated, service_role;
GRANT SELECT ON TABLE public.organization_secrets TO anon;

-- 7. Policies
DROP POLICY IF EXISTS "Allow service_role full access to organization_secrets" ON public.organization_secrets;
CREATE POLICY "Allow service_role full access to organization_secrets"
    ON public.organization_secrets
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated users full access to organization_secrets" ON public.organization_secrets;
CREATE POLICY "Allow authenticated users full access to organization_secrets"
    ON public.organization_secrets
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- 8. Seed / Upsert the organization secrets
INSERT INTO public.organization_secrets (key, value, description, is_secret)
VALUES
    ('GOOGLE_CLIENT_ID', 'YOUR_GOOGLE_CLIENT_ID', 'Google OAuth 2.0 Client ID for Mango Agent', false),
    ('GOOGLE_CLIENT_SECRET', 'YOUR_GOOGLE_CLIENT_SECRET', 'Google OAuth 2.0 Client Secret for Calendar and Gmail access', true),
    ('GOOGLE_SCOPES', 'openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send', 'Authorized OAuth scopes for Google Calendar and Gmail permissions', false),
    ('MANGO_AGENT_NUMBER', '+14849622356', 'Mango Agent direct E.164 phone line', false),
    ('MANGO_PHONE', '14849622356', 'Mango Agent phone number digits', false),
    ('PORT', '3000', 'Mango UI local web server port', false)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    is_secret = EXCLUDED.is_secret,
    updated_at = now();
