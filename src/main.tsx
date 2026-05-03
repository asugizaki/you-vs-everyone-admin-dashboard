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
  startAfter,
  updateDoc,
  where,
  QueryDocumentSnapshot,
  DocumentData
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

const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const PAGE_SIZE = 100;

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [drafts, setDrafts] = useState<DraftQuestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [maxScoreFilter, setMaxScoreFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const isAdmin = user?.email
    ? ADMIN_EMAILS.includes(user.email.toLowerCase())
    : false;

  const selectedCount = selectedIds.length;

  const visibleDrafts = useMemo(() => {
    return drafts.filter((draft) => {
      const matchesSearch =
        search.trim().length === 0 ||
        draft.text.toLowerCase().includes(search.toLowerCase()) ||
        draft.options.some((option) =>
          option.text.toLowerCase().includes(search.toLowerCase())
        );

      const matchesCategory =
        categoryFilter === "all" || draft.category === categoryFilter;

      const score = draft.qualityScore ?? 100;
      const matchesScore =
        maxScoreFilter === "all" || score <= Number(maxScoreFilter);

      return matchesSearch && matchesCategory && matchesScore;
    });
  }, [drafts, search, categoryFilter, maxScoreFilter]);

  const allSelected =
    visibleDrafts.length > 0 &&
    visibleDrafts.every((draft) => selectedIds.includes(draft.id));

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadDrafts(true);
    }
  }, [isAdmin]);

  async function login() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }

  async function loadDrafts(reset = false) {
    setIsLoading(true);

    const constraints = [
      where("status", "==", "draft"),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    ];

    const draftQuery =
      reset || !lastDoc
        ? query(collection(db, "questions"), ...constraints)
        : query(collection(db, "questions"), ...constraints, startAfter(lastDoc));

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

    setDrafts((current) => (reset ? rows : [...current, ...rows]));
    setLastDoc(snapshot.docs[snapshot.docs.length - 1] ?? null);
    setHasMore(snapshot.docs.length === PAGE_SIZE);

    if (reset) setSelectedIds([]);

    setIsLoading(false);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleAllVisible() {
    if (allSelected) {
      setSelectedIds((current) =>
        current.filter((id) => !visibleDrafts.some((draft) => draft.id === id))
      );
      return;
    }

    setSelectedIds((current) =>
      Array.from(new Set([...current, ...visibleDrafts.map((draft) => draft.id)]))
    );
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

    await loadDrafts(true);
    setIsSaving(false);
  }

  if (isLoading && !user) {
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
            {visibleDrafts.length} shown · {drafts.length} loaded · signed in as{" "}
            {user.email}
          </p>
        </div>

        <button className="secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <section className="toolbar card">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search question or option..."
        />

        <select
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
        >
          <option value="all">All categories</option>
          <option value="lifestyle">Lifestyle</option>
          <option value="work">Work</option>
          <option value="curiosity">Curiosity</option>
          <option value="mindset">Mindset</option>
          <option value="money">Money</option>
          <option value="relationships">Relationships</option>
          <option value="entertainment">Entertainment</option>
          <option value="habits">Habits</option>
          <option value="general">General</option>
        </select>

        <select
          value={maxScoreFilter}
          onChange={(event) => setMaxScoreFilter(event.target.value)}
        >
          <option value="all">All scores</option>
          <option value="80">Score ≤ 80</option>
          <option value="70">Score ≤ 70</option>
          <option value="60">Score ≤ 60</option>
          <option value="40">Score ≤ 40</option>
        </select>

        <button className="secondary" onClick={toggleAllVisible}>
          {allSelected ? "Clear Visible" : "Select Visible"}
        </button>

        <button className="secondary" onClick={() => loadDrafts(true)}>
          Refresh
        </button>

        <button
          disabled={selectedCount === 0 || isSaving}
          onClick={() => updateSelected("published")}
        >
          Approve ({selectedCount})
        </button>

        <button
          className="danger"
          disabled={selectedCount === 0 || isSaving}
          onClick={() => updateSelected("rejected")}
        >
          Reject ({selectedCount})
        </button>
      </section>

      {visibleDrafts.length === 0 ? (
        <section className="card center">
          <h2>No matching drafts</h2>
          <p className="muted">Try clearing filters or refreshing.</p>
        </section>
      ) : null}

      <section className="grid">
        {visibleDrafts.map((draft) => {
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

              {draft.qualityReasons?.length ? (
                <ul className="reasons">
                  {draft.qualityReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p className="good">No quality warnings.</p>
              )}
            </article>
          );
        })}
      </section>

      {hasMore ? (
        <div className="loadMore">
          <button disabled={isLoading} onClick={() => loadDrafts(false)}>
            {isLoading ? "Loading..." : "Load More"}
          </button>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
