import { Link } from 'react-router';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/ui';

/** Step 1 of the waiter flow: choose the hall (decides the price list) → menu → confirm → print. */
export function NewOrderPage() {
  const { t } = useI18n();
  const halls = [
    { key: 'nonac' as const, icon: '🌀', cls: 'bg-accent-soft border-accent text-primary-dark' },
    { key: 'ac' as const, icon: '❄️', cls: 'bg-[#DCEAF7] border-[#1D4E89] text-[#1D4E89]' },
  ];
  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title={t('tables.newOrder')} />
      <p className="text-muted mb-4">{t('neworder.choose')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {halls.map((h) => (
          <Link key={h.key} to={`/order/${h.key}`} data-testid={`hall-${h.key}`}
            className={`card border-2 ${h.cls} p-6 min-h-36 flex flex-col items-center justify-center gap-2 text-center active:scale-[.98] transition hover:shadow-md`}>
            <span aria-hidden className="text-5xl">{h.icon}</span>
            <span className="text-2xl font-bold">{t(`hall.${h.key}`)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
