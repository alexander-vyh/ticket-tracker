'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MultiLegForm } from '@/components/MultiLegForm';
import styles from './page.module.css';

/**
 * Enter a non-standard itinerary — open-jaw (return from a different city) or
 * multi-city — and start tracking it. Round-trip and one-way have their quick
 * paths on the home page; this route covers the shapes those can't express.
 */
export default function MultiLegPage() {
  const router = useRouter();
  return (
    <main className={styles.main}>
      <nav className={styles.topBar}>
        <Link href="/" className={styles.brand}>
          Flight Finder
        </Link>
      </nav>
      <header className={styles.header}>
        <h1 className={styles.title}>Open-jaw &amp; multi-city</h1>
        <p className={styles.sub}>
          Add each leg of your trip. Fly into one city and home from another (open jaw),
          or chain several stops (multi-city). Prices track for your whole party.
        </p>
      </header>
      <section className={styles.card}>
        <MultiLegForm
          onCreated={(ids) => {
            if (ids[0]) router.push(`/q/${ids[0]}`);
          }}
        />
      </section>
    </main>
  );
}
