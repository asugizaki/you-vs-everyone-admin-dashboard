import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User
} from "firebase/auth";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "firebase/firestore";
import { auth, db } from "./firebase";
import "./styles.css";

type DraftQuestion = {
  id: string;
  text: string;
  category: string;
  options: { id: string; text: string }[];
  qualityScore?: number;
  qualityReasons?: string[];
  generationBatchId?: string;
};

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL;

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [drafts, setDrafts] = useState<DraftQuestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const isAdmin = user?.email === ADMIN_EMAIL;

  const selectedCount = selectedIds.length;

  const allSelected = useMemo(
    () => drafts.length > 0 && selectedIds.length === drafts.length,
    [drafts.length, selectedIds.length]
  );

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadDrafts();
    }
  }, [isAdmin]);

  async function login() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async function loadDrafts() {
    setIsLoading(true);

    const draftQuery = query(
      collection(db, "questions"),
      where("status", "==", "draft"),
      orderBy("createdAt", "desc"),
      limit(300)
    );

    const snapshot = await getDocs(draftQuery);

    const rows = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();

      return {
        id: docSnap.id,
        text: data.text,
        category: data.category,
        options: data.options ?? [],
        qualityScore: data.qualityScore,
        qualityReasons: data.qualityReasons ?? [],
        generationBatchId: data.generationBatchId
      };
    });

    setDrafts(rows);
    setSelectedIds([]);
    setIsLoading(false);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : drafts.map((draft) => draft.id));
  }

  async function updateSelected(status: "published" | "rejected") {
    if (selectedIds.length === 0) return;

    setIsSaving(true);

    await Promise.all(
      selectedIds.map((id) =>
        updateDoc(doc(db, "questions", id), {
          status,
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        })
      )
    );

    await loadDrafts();

    setIsSaving(false);
  }

  if (isLoading) {
    return (
      <main className="page">
        <section className="card center">
          <p className="muted">Loading...</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="page">
        <section className="card hero">
          <h1>You vs Everyone Admin</h1>
          <p>Sign in to review AI-generated draft questions.</p>
          <button onClick={login}>Sign in with Google</button>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="page">
        <section className="card hero">
          <h1>Access denied</h1>
          <p className="muted">
            Signed in as {user.email}. This account is not authorized.
          </p>
          <button onClick={() => signOut(auth)}>Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <h1>Draft Questions</h1>
          <p className="muted">
            {drafts.length} waiting for review · signed in as {user.email}
          </p>
        </div>

        <button className="secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <section className="toolbar card">
        <button className="secondary" onClick={toggleAll}>
          {allSelected ? "Clear Selection" : "Select All"}
        </button>

        <button className="secondary" onClick={loadDrafts}>
          Refresh
        </button>

        <button disabled={selectedCount === 0 || isSaving} onClick={() => updateSelected("published")}>
          Approve Selected ({selectedCount})
        </button>

        <button
          className="danger"
          disabled={selectedCount === 0 || isSaving}
          onClick={() => updateSelected("rejected")}
        >
          Reject Selected ({selectedCount})
        </button>
      </section>

      {drafts.length === 0 ? (
        <section className="card center">
          <h2>No draft questions</h2>
          <p className="muted">Everything is reviewed.</p>
        </section>
      ) : null}

      <section className="grid">
        {drafts.map((draft) => {
          const selected = selectedIds.includes(draft.id);

          return (
            <article
              key={draft.id}
              className={`question-card ${selected ? "selected" : ""}`}
              onClick={() => toggleSelected(draft.id)}
            >
              <div className="row">
                <span className="pill">{draft.category}</span>
                <span className="score">Score {draft.qualityScore ?? "?"}</span>
              </div>

              <h2>{draft.text}</h2>

              <div className="option">
                <strong>A</strong>
                <span>{draft.options[0]?.text}</span>
              </div>

              <div className="option">
                <strong>B</strong>
                <span>{draft.options[1]?.text}</span>
              </div>

              {draft.qualityReasons && draft.qualityReasons.length > 0 ? (
                <ul className="reasons">
                  {draft.qualityReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="good">No quality warnings.</p>
              )}

              {draft.generationBatchId ? (
                <p className="batch">{draft.generationBatchId}</p>
              ) : null}
            </article>
          );
        })}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
