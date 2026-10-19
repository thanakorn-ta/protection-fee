import App from '@/components/App';
import { devLoginEnabled, googleClientId } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <App googleClientId={googleClientId()} devLogin={devLoginEnabled()} />;
}
