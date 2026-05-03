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
  addDoc,
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

type AdminTab = "drafts" | "submissions";

type QuestionRow = {
  id: string;
  text: string;
  category: string;
  options: { id: string; text: string }[];
  qualityScore?: number;
  qualityReasons?: string[];
  generationBatchId?: string;
};

type SubmittedQuestion = {
  id: string;
  text: string;
  category: string;
  options: { id: string; text: string }[];
  submittedBy?: string;
  status: string;
};

const ADMIN_EMAILS = String(import.meta.env.VITE_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const PAGE_SIZE = 100;

function App() {
  const [tab, setTab] = useState<AdminTab>("drafts");
  const [user, setUser] = useState<User | null>(null);

  const [drafts, setDrafts] = useState<QuestionRow[]>([]);
  const [submissions, setSubmissions] = useState<SubmittedQuestion[]>([]);

  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);
  const [selectedSubmissionIds, setSelectedSubmissionIds] = useState<string[]>(
    []
  );

  const [lastDraftDoc, setLastDraftDoc] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [lastSubmissionDoc, setLastSubmissionDoc] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);

  const [hasMoreDrafts, setHasMoreDrafts] = useState(false);
  const [hasMoreSubmissions, setHasMoreSubmissions] = useState(false);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [maxScoreFilter, setMaxScoreFilter] = useState("all");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const isAdmin = user?.email
    ? ADMIN_EMAILS.includes(user.email.toLowerCase())
    : false;

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

  const visibleSubmissions = useMemo(() => {
    return submissions.filter((submission) => {
      const matchesSearch =
        search.trim().length === 0 ||
        submission.text.toLowerCase().includes(search.toLowerCase()) ||
        submission.options.some((option) =>
          option.text.toLowerCase().includes(search.toLowerCase())
        );

      const matchesCategory =
        categoryFilter === "all" || submission.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [submissions, search, categoryFilter]);

  const allVisibleDraftsSelected =
    visibleDrafts.length > 0 &&
    visibleDrafts.every((draft) => selectedDraftIds.includes(draft.id));

  const allVisibleSubmissionsSelected =
    visibleSubmissions.length > 0 &&
    visibleSubmissions.every((submission) =>
      selectedSubmissionIds.includes(submission.id)
    );

  useEffect(() => {
    return onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!isAdmin) return;

    if (tab === "drafts") {
      void loadDrafts(true);
    } else {
      void loadSubmissions(true);
    }
  }, [isAdmin, tab]);

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
      reset || !lastDraftDoc
        ? query(collection(db, "questions"), ...constraints)
        : query(
            collection(db, "questions"),
            ...constraints,
            startAfter(lastDraftDoc)
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

    setDrafts((current) => (reset ? rows : [...current, ...rows]));
    setLastDraftDoc(snapshot.docs[snapshot.docs.length - 1] ?? null);
    setHasMoreDrafts(snapshot.docs.length === PAGE_SIZE);

    if (reset) setSelectedDraftIds([]);
    setIsLoading(false);
  }

  async function loadSubmissions(reset = false) {
    setIsLoading(true);

    const constraints = [
      where("status", "==", "pending"),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    ];

    const submissionQuery =
      reset || !lastSubmissionDoc
        ? query(collection(db, "submittedQuestions"), ...constraints)
        : query(
            collection(db, "submittedQuestions"),
            ...constraints,
            startAfter(lastSubmissionDoc)
          );

    const snapshot = await getDocs(submissionQuery);

    const rows = snapshot.docs.map((docSnap) => {
      const data = docSnap.data();

      return {
        id: docSnap.id,
        text: data.text,
        category: data.category,
        options: data.options ?? [],
        submittedBy: data.submittedBy,
        status: data.status
      };
    });

    setSubmissions((current) => (reset ? rows : [...current, ...rows]));
    setLastSubmissionDoc(snapshot.docs[snapshot.docs.length - 1] ?? null);
    setHasMoreSubmissions(snapshot.docs.length === PAGE_SIZE);

    if (reset) setSelectedSubmissionIds([]);
    setIsLoading(false);
  }

  function toggleDraftSelected(id: string) {
    setSelectedDraftIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleSubmissionSelected(id: string) {
    setSelectedSubmissionIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleAllVisibleDrafts() {
    if (allVisibleDraftsSelected) {
      setSelectedDraftIds((current) =>
        current.filter((id) => !visibleDrafts.some((draft) => draft.id === id))
      );
      return;
    }

    setSelectedDraftIds((current) =>
      Array.from(new Set([...current, ...visibleDrafts.map((draft) => draft.id)]))
    );
  }

  function toggleAllVisibleSubmissions() {
    if (allVisibleSubmissionsSelected) {
      setSelectedSubmissionIds((current) =>
        current.filter(
          (id) => !visibleSubmissions.some((item) => item.id === id)
        )
      );
      return;
    }

    setSelectedSubmissionIds((current) =>
      Array.from(new Set([...current, ...visibleSubmissions.map((item) => item.id)]))
    );
  }

  async function updateDrafts(status: "published" | "rejected") {
    if (selectedDraftIds.length === 0) return;

    setIsSaving(true);

    await Promise.all(
      selectedDraftIds.map((id) =>
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

  async function approveSubmissions() {
    if (selectedSubmissionIds.length === 0) return;

    setIsSaving(true);

    const selected = submissions.filter((item) =>
      selectedSubmissionIds.includes(item.id)
    );

    await Promise.all(
      selected.map(async (submission) => {
        await addDoc(collection(db, "questions"), {
          text: submission.text,
          category: submission.category,
          options: submission.options,
          status: "published",
          source: "user_submitted",
          submittedQuestionId: submission.id,
          approvedBy: user?.email ?? null,
          randomKey: Math.random(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        await updateDoc(doc(db, "submittedQuestions", submission.id), {
          status: "approved",
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        });
      })
    );

    await loadSubmissions(true);
    setIsSaving(false);
  }

  async function rejectSubmissions() {
    if (selectedSubmissionIds.length === 0) return;

    setIsSaving(true);

    await Promise.all(
      selectedSubmissionIds.map((id) =>
        updateDoc(doc(db, "submittedQuestions", id), {
          status: "rejected",
          reviewedAt: serverTimestamp(),
          reviewedBy: user?.email ?? null,
          updatedAt: serverTimestamp()
        })
      )
    );

    await loadSubmissions(true);
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
          <p>Sign in to review questions.</p>
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
          <h1>Question Admin</h1>
          <p className="muted">Signed in as {user.email}</p>
        </div>

        <button className="secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>

      <section className="tabs">
        <button
          className={tab === "drafts" ? "" : "secondary"}
          onClick={() => setTab("drafts")}
        >
          AI Drafts ({drafts.length})
        </button>

        <button
          className={tab === "submissions" ? "" : "secondary"}
          onClick={() => setTab("submissions")}
        >
          User Submissions ({submissions.length})
        </button>
      </section>

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

        {tab === "drafts" ? (
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
        ) : null}

        {tab === "drafts" ? (
          <>
            <button className="secondary" onClick={toggleAllVisibleDrafts}>
              {allVisibleDraftsSelected ? "Clear Visible" : "Select Visible"}
            </button>

            <button className="secondary" onClick={() => loadDrafts(true)}>
              Refresh
            </button>

            <button
              disabled={selectedDraftIds.length === 0 || isSaving}
              onClick={() => updateDrafts("published")}
            >
              Approve ({selectedDraftIds.length})
            </button>

            <button
              className="danger"
              disabled={selectedDraftIds.length === 0 || isSaving}
              onClick={() => updateDrafts("rejected")}
            >
              Reject ({selectedDraftIds.length})
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              onClick={toggleAllVisibleSubmissions}
            >
              {allVisibleSubmissionsSelected
                ? "Clear Visible"
                : "Select Visible"}
            </button>

            <button className="secondary" onClick={() => loadSubmissions(true)}>
              Refresh
            </button>

            <button
              disabled={selectedSubmissionIds.length === 0 || isSaving}
              onClick={approveSubmissions}
            >
              Approve ({selectedSubmissionIds.length})
            </button>

            <button
              className="danger"
              disabled={selectedSubmissionIds.length === 0 || isSaving}
              onClick={rejectSubmissions}
            >
              Reject ({selectedSubmissionIds.length})
            </button>
          </>
        )}
      </section>

      {tab === "drafts" ? (
        <>
          <p className="muted">
            {visibleDrafts.length} shown · {drafts.length} loaded
          </p>

          <section className="grid">
            {visibleDrafts.map((draft) => {
              const selected = selectedDraftIds.includes(draft.id);

              return (
                <article
                  key={draft.id}
                  className={`question-card ${selected ? "selected" : ""}`}
                  onClick={() => toggleDraftSelected(draft.id)}
                >
                  <div className="row">
                    <span className="pill">{draft.category}</span>
                    <span className="score">
                      Score {draft.qualityScore ?? "N/A"}
                    </span>
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
                </article>
              );
            })}
          </section>

          {hasMoreDrafts ? (
            <div className="loadMore">
              <button disabled={isLoading} onClick={() => loadDrafts(false)}>
                {isLoading ? "Loading..." : "Load More"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="muted">
            {visibleSubmissions.length} shown · {submissions.length} loaded
          </p>

          <section className="grid">
            {visibleSubmissions.map((submission) => {
              const selected = selectedSubmissionIds.includes(submission.id);

              return (
                <article
                  key={submission.id}
                  className={`question-card ${selected ? "selected" : ""}`}
                  onClick={() => toggleSubmissionSelected(submission.id)}
                >
                  <div className="row">
                    <span className="pill">{submission.category}</span>
                    <span className="score">User submitted</span>
                  </div>

                  <h2>{submission.text}</h2>

                  <div className="option">
                    <strong>A</strong>
                    <span>{submission.options[0]?.text}</span>
                  </div>

                  <div className="option">
                    <strong>B</strong>
                    <span>{submission.options[1]?.text}</span>
                  </div>

                  {submission.submittedBy ? (
                    <p className="batch">Submitted by: {submission.submittedBy}</p>
                  ) : null}
                </article>
              );
            })}
          </section>

          {hasMoreSubmissions ? (
            <div className="loadMore">
              <button
                disabled={isLoading}
                onClick={() => loadSubmissions(false)}
              >
                {isLoading ? "Loading..." : "Load More"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
