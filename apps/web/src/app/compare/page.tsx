'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSavedTrackers, type SavedTracker } from '@/lib/tracker-storage';
import { OptionComparison } from '@/components/OptionComparison';
import { Footer } from '@/components/Footer';
import styles from './page.module.css';

export default function ComparePage() {
  const [trackers, setTrackers] = useState<SavedTracker[] | null>(null);

  useEffect(() => {
    setTrackers(getSavedTrackers());
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Link href="/" className={styles.back}>&larr; Back</Link>
        <h1 className={styles.title}>Compare options</h1>
        <p className={styles.subtitle}>
          Side-by-side total family price across the trackers you&apos;ve created &mdash;
          round trip, split one-ways, open-jaw, whatever shape you&apos;re considering.
        </p>
      </div>

      {trackers === null ? (
        <p className={styles.loading}>Loading your trackers…</p>
      ) : (
        <OptionComparison trackers={trackers} />
      )}

      <Footer />
    </div>
  );
}
