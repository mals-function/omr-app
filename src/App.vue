<script setup>
import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  shallowRef,
  watch
} from 'vue';

import {
  IonApp,
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonFooter
} from '@ionic/vue';

import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from 'firebase/auth';

import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc
} from 'firebase/firestore';

import { Capacitor } from '@capacitor/core';

import {
  Camera,
  CameraResultType,
  CameraSource
} from '@capacitor/camera';

import {
  Filesystem,
  Directory,
  Encoding
} from '@capacitor/filesystem';

import { Share } from '@capacitor/share';

import Papa from 'papaparse';

import { auth, db, configured } from './firebase';
import {
  buildSections,
  grade,
  layoutSignature,
  questions
} from './model';

import {
  detectCorners,
  loadImage,
  scanSheet,
  sheetSvg
} from './scanner';

const user = shallowRef(null);
const ready = ref(!configured);
const busy = ref(false);
const message = ref('');

const email = ref('');
const password = ref('');

const tab = ref('exams');

const classes = ref([]);
const students = ref([]);
const exams = ref([]);
const results = ref([]);

const className = ref('');
const selectedClassId = ref('');

const studentNumber = ref('');
const studentName = ref('');
const importPreview = ref([]);

const examTitle = ref('');
const examClassId = ref('');
const editingId = ref('');
const editingVersion = ref(0);

function emptySection() {
  return {
    name: 'Section',
    type: 'MCQ',
    keyText: '',
    points: 1,
    penalty: 0
  };
}

const sectionDrafts = ref([emptySection()]);

const selectedExamId = ref('');
const selectedStudentId = ref('');

const answers = ref([]);
const detectedAnswers = ref([]);
const source = ref('manual');
const reviewed = ref(false);
const scanned = ref(false);
const entryVersion = ref(0);

const original = shallowRef(null);
const photoUrl = ref('');
const previewUrl = ref('');
const corners = ref([]);
const cameraActive = ref(false);
const cameraVideo = ref(null);

let cameraStream;

let listeners = [];

const exam = computed(() =>
  exams.value.find(item => item.id === selectedExamId.value)
);

const items = computed(() => questions(exam.value));

const roster = computed(() =>
  students.value.filter(item => item.classId === exam.value?.classId)
);

const classStudents = computed(() =>
  students.value.filter(item => item.classId === selectedClassId.value)
);

const examResults = computed(() =>
  results.value.filter(item => item.examId === selectedExamId.value)
);

const currentResults = computed(() =>
  examResults.value.filter(item => item.keyVersion === exam.value?.version)
);

const staleResults = computed(() =>
  examResults.value.filter(item => item.keyVersion !== exam.value?.version)
);

const average = computed(() => {
  if (!currentResults.value.length) return 0;

  return (
    currentResults.value.reduce((sum, item) => sum + item.percentage, 0) /
    currentResults.value.length
  ).toFixed(1);
});

const analysis = computed(() =>
  items.value.map((question, index) => ({
    number: index + 1,
    correct: currentResults.value.filter(
      result => result.answers[index] === question.correct
    ).length,
    blank: currentResults.value.filter(
      result => result.answers[index] === ''
    ).length,
    multiple: currentResults.value.filter(
      result => result.answers[index] === 'MULTIPLE'
    ).length
  }))
);

const scorePreview = computed(() => {
  try {
    return exam.value ? grade(answers.value, exam.value) : null;
  } catch {
    return null;
  }
});

const canSave = computed(() =>
  Boolean(
    exam.value &&
    selectedStudentId.value &&
    reviewed.value &&
    scorePreview.value &&
    entryVersion.value === exam.value.version &&
    (source.value === 'manual' || scanned.value)
  )
);

function uid() {
  if (!user.value) throw new Error('Log in first.');
  return user.value.uid;
}

function reference(name, id) {
  return doc(db, 'teachers', uid(), name, id);
}

function collectionReference(name) {
  return collection(db, 'teachers', uid(), name);
}

async function task(action) {
  if (busy.value) return;

  busy.value = true;
  message.value = '';

  try {
    await action();
  } catch (error) {
    message.value = error.message ?? String(error);
  } finally {
    busy.value = false;
  }
}

function resetEntry() {
  stopCamera();
  answers.value = items.value.map(() => '');
  detectedAnswers.value = [];
  source.value = 'manual';
  reviewed.value = false;
  scanned.value = false;

  original.value = null;
  photoUrl.value = '';
  previewUrl.value = '';
  corners.value = [];

  entryVersion.value = exam.value?.version ?? 0;
}

watch(selectedExamId, () => {
  selectedStudentId.value = '';
  resetEntry();
});

watch(selectedStudentId, resetEntry);

function stopData() {
  listeners.forEach(stop => stop());
  listeners = [];
}

const stopAuth = auth
  ? onAuthStateChanged(auth, account => {
      stopData();

      user.value = account;
      ready.value = true;
      password.value = '';

      classes.value = [];
      students.value = [];
      exams.value = [];
      results.value = [];
      importPreview.value = [];

      selectedClassId.value = '';
      selectedExamId.value = '';
      selectedStudentId.value = '';

      resetEntry();

      if (!account) return;

      const accountUid = account.uid;

      function subscribe(name, target) {
        listeners.push(
          onSnapshot(
            collection(db, 'teachers', accountUid, name),
            snapshot => {
              if (user.value?.uid !== accountUid) return;

              target.value = snapshot.docs.map(item => ({
                ...item.data(),
                id: item.id
              }));
            },
            error => {
              if (user.value?.uid === accountUid) {
                message.value = error.message;
              }
            }
          )
        );
      }

      subscribe('classes', classes);
      subscribe('students', students);
      subscribe('exams', exams);
      subscribe('results', results);
    })
  : () => {};

onUnmounted(() => {
  stopAuth();
  stopData();
  stopCamera();
});

function login(register = false) {
  return task(async () => {
    if (!auth) throw new Error('Configure Firebase first.');

    if (register) {
      await createUserWithEmailAndPassword(
        auth,
        email.value.trim(),
        password.value
      );
    } else {
      await signInWithEmailAndPassword(
        auth,
        email.value.trim(),
        password.value
      );
    }
  });
}

function resetPassword() {
  return task(async () => {
    if (!email.value.trim()) throw new Error('Enter your email.');

    await sendPasswordResetEmail(auth, email.value.trim());
    message.value = 'Password reset requested. Check your email.';
  });
}

function logout() {
  return task(() => signOut(auth));
}

function createClass() {
  return task(async () => {
    const name = className.value.trim();

    if (!name || name.length > 80) {
      throw new Error('Enter a class name of up to 80 characters.');
    }

    if (classes.value.some(item => item.name === name)) {
      throw new Error('That class name already exists.');
    }

    const target = doc(collectionReference('classes'));

    await setDoc(target, {
      name,
      createdAt: serverTimestamp()
    });

    className.value = '';
    message.value = 'Class created.';
  });
}

function studentRecord(number, name, classId) {
  number = String(number).trim();
  name = String(name).trim();

  if (!classId) throw new Error('Select a class.');

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(number)) {
    throw new Error('Use letters, numbers, underscores or hyphens in IDs.');
  }

  if (!name || name.length > 120) {
    throw new Error('Enter a student name of up to 120 characters.');
  }

  return {
    id: `${classId}_${number}`,
    number,
    name,
    classId
  };
}

async function insertStudents(records) {
  const references = records.map(item =>
    reference('students', item.id)
  );

  await runTransaction(db, async transaction => {
    const snapshots = await Promise.all(
      references.map(item => transaction.get(item))
    );

    if (snapshots.some(item => item.exists())) {
      throw new Error('A student number already exists in this class.');
    }

    references.forEach((item, index) => {
      transaction.set(item, records[index]);
    });
  });
}

function addStudent() {
  return task(async () => {
    await insertStudents([
      studentRecord(
        studentNumber.value,
        studentName.value,
        selectedClassId.value
      )
    ]);

    studentNumber.value = '';
    studentName.value = '';
    message.value = 'Student saved.';
  });
}

function readCsv(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';

  if (!file) return;

  return task(async () => {
    importPreview.value = [];

    if (!selectedClassId.value) throw new Error('Select a class first.');
    if (file.size > 1_000_000) throw new Error('Use a CSV smaller than 1 MB.');

    const parsed = Papa.parse(await file.text(), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: value => value.replace(/^\uFEFF/, '').trim()
    });

    if (parsed.errors.length) throw new Error(parsed.errors[0].message);

    if (
      !parsed.meta.fields?.includes('studentNumber') ||
      !parsed.meta.fields?.includes('name')
    ) {
      throw new Error('Required CSV columns: studentNumber,name');
    }

    if (!parsed.data.length || parsed.data.length > 200) {
      throw new Error('Import 1–200 students at a time.');
    }

    const seen = new Set(students.value.map(item => item.id));

    importPreview.value = parsed.data.map(row => {
      const item = studentRecord(
        row.studentNumber ?? '',
        row.name ?? '',
        selectedClassId.value
      );

      if (seen.has(item.id)) {
        throw new Error(`Duplicate student: ${item.number}`);
      }

      seen.add(item.id);
      return item;
    });
  });
}

function confirmImport() {
  return task(async () => {
    if (!importPreview.value.length) throw new Error('Select a CSV.');

    await insertStudents(importPreview.value);
    importPreview.value = [];

    message.value = 'Import saved.';
  });
}

function newExam() {
  editingId.value = '';
  editingVersion.value = 0;
  examTitle.value = '';
  examClassId.value = '';
  sectionDrafts.value = [emptySection()];
  tab.value = 'create';
}

function editKey() {
  if (!exam.value) return;

  editingId.value = exam.value.id;
  editingVersion.value = exam.value.version;
  examTitle.value = exam.value.title;
  examClassId.value = exam.value.classId;

  sectionDrafts.value = exam.value.sections.map(section => ({
    name: section.name,
    type: section.type,
    keyText: section.key.join(','),
    points: section.points,
    penalty: section.penalty
  }));

  tab.value = 'create';
}

function saveExam() {
  return task(async () => {
    const title = examTitle.value.trim();

    if (!title || title.length > 120 || !examClassId.value) {
      throw new Error('Enter a title and select a class.');
    }

    const sections = buildSections(sectionDrafts.value);

    if (editingId.value) {
      const target = reference('exams', editingId.value);

      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(target);

        if (!snapshot.exists()) throw new Error('Exam no longer exists.');

        const old = snapshot.data();

        if (old.version !== editingVersion.value) {
          throw new Error('The key changed elsewhere. Reopen the editor.');
        }

        if (layoutSignature(old.sections) !== layoutSignature(sections)) {
          throw new Error(
            'Keep section types and question counts unchanged. ' +
            'Create a new exam to change the sheet layout.'
          );
        }

        transaction.set(
          doc(collection(target, 'keyHistory')),
          {
            sections: old.sections,
            version: old.version,
            replacedAt: serverTimestamp()
          }
        );

        transaction.update(target, {
          sections,
          version: old.version + 1,
          updatedAt: serverTimestamp()
        });
      });

      message.value = 'Answer key updated. Regrade outdated results.';
    } else {
      await setDoc(doc(collectionReference('exams')), {
        title,
        classId: examClassId.value,
        sections,
        version: 1,
        createdAt: serverTimestamp()
      });

      message.value = 'Exam created.';
    }

    tab.value = 'exams';
  });
}

function openExam(item) {
  selectedExamId.value = item.id;
  tab.value = 'exam';
}

async function saveFile(name, mime, content) {
  if (Capacitor.isNativePlatform()) {
    const file = await Filesystem.writeFile({
      path: name,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      data: content
    });

    await Share.share({
      title: name,
      files: [file.uri]
    });

    return;
  }

  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');

  link.href = url;
  link.download = name;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function printSheet() {
  return task(async () => {
    if (!exam.value) throw new Error('Select an exam.');

    await saveFile(
      `sheet-${exam.value.id}.svg`,
      'image/svg+xml',
      sheetSvg(exam.value)
    );
  });
}

async function setCanvas(canvas) {
  if (!exam.value) throw new Error('Select an exam.');

  original.value = canvas;
  photoUrl.value = canvas.toDataURL('image/jpeg', 0.9);

  previewUrl.value = '';
  corners.value = await detectCorners(canvas);
  detectedAnswers.value = [];
  answers.value = items.value.map(() => '?');

  source.value = 'scan';
  scanned.value = false;
  reviewed.value = false;
  entryVersion.value = exam.value.version;
}

async function setPhoto(url) {
  await setCanvas(await loadImage(url));
}

function uploadPhoto(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';

  if (!file) return;

  return task(async () => {
    if (file.size > 15_000_000) throw new Error('Use an image under 15 MB.');

    const url = URL.createObjectURL(file);

    try {
      await setPhoto(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

function takePhoto() {
  return task(async () => {
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.Uri,
      source: CameraSource.Camera,
      correctOrientation: true
    });

    if (!photo.webPath) throw new Error('No photograph returned.');

    await setPhoto(photo.webPath);
  });
}

function stopCamera() {
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraActive.value = false;
  if (cameraVideo.value) cameraVideo.value.srcObject = null;
}

function startCamera() {
  return task(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Live camera access is not available in this browser.');
    }

    stopCamera();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    cameraActive.value = true;
    await nextTick();
    cameraVideo.value.srcObject = cameraStream;
    await cameraVideo.value.play();
  });
}

function captureCameraFrame() {
  return task(async () => {
    const video = cameraVideo.value;

    if (!cameraActive.value || !video?.videoWidth) {
      throw new Error('Start the live camera first.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    stopCamera();
    await setCanvas(canvas);
  });
}

function selectCorner(event) {
  if (
    busy.value ||
    scanned.value ||
    !original.value ||
    corners.value.length >= 4
  ) return;

  const bounds = event.currentTarget.getBoundingClientRect();

  corners.value.push({
    x: (event.clientX - bounds.left) *
      original.value.width / bounds.width,
    y: (event.clientY - bounds.top) *
      original.value.height / bounds.height
  });
}

function resetCorners() {
  corners.value = [];
  previewUrl.value = '';
  scanned.value = false;
  reviewed.value = false;
  answers.value = items.value.map(() => '?');
}

function recognize() {
  return task(async () => {
    if (!original.value || !exam.value) {
      throw new Error('Select an exam and upload a photograph.');
    }

    if (entryVersion.value !== exam.value.version) {
      throw new Error('The answer key changed. Start the entry again.');
    }

    const result = await scanSheet(
      original.value,
      corners.value,
      exam.value
    );

    answers.value = [...result.answers];
    detectedAnswers.value = [...result.answers];
    previewUrl.value = result.preview;
    scanned.value = true;

    message.value = 'Review every answer before saving.';
  });
}

function saveResult() {
  return task(async () => {
    if (!canSave.value) {
      throw new Error('Select a student and finish reviewing the answers.');
    }

    const selectedExam = exam.value;
    const selectedStudent = roster.value.find(
      item => item.id === selectedStudentId.value
    );

    if (!selectedStudent) throw new Error('Student is not in this class.');

    const resultId = `${selectedExam.id}_${selectedStudent.id}`;
    const target = reference('results', resultId);
    const examReference = reference('exams', selectedExam.id);

    const finalAnswers = [...answers.value];
    const originalDetection = [...detectedAnswers.value];
    const inputSource = source.value;

    await runTransaction(db, async transaction => {
      const examSnapshot = await transaction.get(examReference);
      const resultSnapshot = await transaction.get(target);

      if (!examSnapshot.exists()) throw new Error('Exam not found.');
      if (resultSnapshot.exists()) {
        throw new Error('This student already has a result for this exam.');
      }

      const latestExam = examSnapshot.data();

      if (latestExam.version !== entryVersion.value) {
        throw new Error('The key changed. Review against the latest key.');
      }

      transaction.set(target, {
        examId: selectedExam.id,
        examTitle: latestExam.title,
        classId: latestExam.classId,
        studentId: selectedStudent.id,
        studentNumber: selectedStudent.number,
        studentName: selectedStudent.name,
        answers: finalAnswers,
        detectedAnswers: originalDetection,
        source: inputSource,
        keyVersion: latestExam.version,
        ...grade(finalAnswers, latestExam),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    });

    selectedStudentId.value = '';
    resetEntry();

    message.value = 'Saved. Select the next student to continue scanning.';
  });
}

function regradeResults() {
  return task(async () => {
    const examId = selectedExamId.value;
    const resultIds = examResults.value.map(item => item.id);

    for (const id of resultIds) {
      const target = reference('results', id);
      const examReference = reference('exams', examId);

      await runTransaction(db, async transaction => {
        const e = await transaction.get(examReference);
        const r = await transaction.get(target);

        if (!e.exists() || !r.exists()) return;

        const latestExam = e.data();
        const previous = r.data();

        if (previous.keyVersion === latestExam.version) return;

        transaction.set(
          doc(collection(target, 'history')),
          {
            score: previous.score,
            maxScore: previous.maxScore,
            keyVersion: previous.keyVersion,
            replacedAt: serverTimestamp()
          }
        );

        transaction.update(target, {
          ...grade(previous.answers, latestExam),
          keyVersion: latestExam.version,
          updatedAt: serverTimestamp()
        });
      });
    }

    message.value = 'Regrading completed.';
  });
}

function exportResults() {
  return task(async () => {
    if (staleResults.value.length) {
      throw new Error('Regrade outdated results before exporting.');
    }

    const csv = Papa.unparse(
      currentResults.value.map(result => ({
        studentNumber: result.studentNumber,
        studentName: result.studentName,
        exam: result.examTitle,
        score: result.score,
        maxScore: result.maxScore,
        percentage: result.percentage,
        keyVersion: result.keyVersion
      })),
      { escapeFormulae: true }
    );

    await saveFile(
      'exam-results.csv',
      'text/csv;charset=utf-8',
      '\uFEFF' + csv
    );
  });
}
</script>

<template>
  <ion-app>
    <ion-page>
      <ion-header>
        <ion-toolbar>
          <ion-title>OMR Teacher</ion-title>
        </ion-toolbar>
      </ion-header>

      <ion-content>
        <main>
          <p v-if="message" class="message" role="status">
            {{ message }}
          </p>

          <p v-if="busy">Working… Keep the application open.</p>

          <section v-if="!configured">
            <h1>Connect Firebase</h1>
            <p>
              Fill in .env.local and restart npm run dev.
            </p>
          </section>

          <p v-else-if="!ready">Loading account…</p>

          <fieldset v-else :disabled="busy">
            <section v-if="!user">
              <h1>Teacher login</h1>

              <label>
                Email
                <input
                  v-model="email"
                  type="email"
                  autocomplete="username"
                />
              </label>

              <label>
                Password
                <input
                  v-model="password"
                  type="password"
                  autocomplete="current-password"
                />
              </label>

              <div class="actions">
                <button @click="login()">Log in</button>
                <button @click="login(true)">Create account</button>
                <button class="secondary" @click="resetPassword">
                  Reset password
                </button>
              </div>
            </section>

            <template v-else>
              <template v-if="tab === 'classes'">
                <section>
                  <h1>Classes</h1>

                  <label>
                    New class name
                    <input v-model="className" placeholder="BSIT-1A" />
                  </label>

                  <button @click="createClass">Create class</button>
                </section>

                <section>
                  <label>
                    Select class
                    <select
                      v-model="selectedClassId"
                      @change="importPreview = []"
                    >
                      <option value="">Choose a class</option>
                      <option
                        v-for="item in classes"
                        :key="item.id"
                        :value="item.id"
                      >
                        {{ item.name }}
                      </option>
                    </select>
                  </label>

                  <template v-if="selectedClassId">
                    <h2>Add student</h2>

                    <label>
                      Student number
                      <input v-model="studentNumber" />
                    </label>

                    <label>
                      Full name
                      <input v-model="studentName" />
                    </label>

                    <button @click="addStudent">Add student</button>

                    <h2>Import CSV</h2>
                    <p>Required columns: studentNumber,name</p>

                    <input
                      type="file"
                      accept=".csv,text/csv"
                      aria-label="Import student CSV"
                      @change="readCsv"
                    />

                    <div v-if="importPreview.length">
                      <h3>Import preview</h3>

                      <ul>
                        <li v-for="s in importPreview" :key="s.id">
                          {{ s.number }} — {{ s.name }}
                        </li>
                      </ul>

                      <button @click="confirmImport">
                        Confirm import
                      </button>
                    </div>

                    <h2>Class roster</h2>

                    <ul>
                      <li v-for="s in classStudents" :key="s.id">
                        {{ s.number }} — {{ s.name }}
                      </li>
                    </ul>
                  </template>
                </section>
              </template>

              <template v-if="tab === 'exams'">
                <section class="hero">
                  <h1>Your assessments</h1>
                  <p>Create, scan, review, and record.</p>
                  <button @click="newExam">Create exam</button>
                </section>

                <section v-for="e in exams" :key="e.id">
                  <h2>{{ e.title }}</h2>
                  <p>
                    {{ questions(e).length }} questions ·
                    {{ e.sections.length }} sections ·
                    Key version {{ e.version }}
                  </p>
                  <button @click="openExam(e)">Open exam</button>
                </section>

                <p v-if="!exams.length">
                  Create a class, import students, then create your exam.
                </p>
              </template>

              <section v-if="tab === 'create'">
                <h1>
                  {{ editingId ? 'Edit answer key' : 'Create exam' }}
                </h1>

                <label>
                  Exam title
                  <input v-model="examTitle" :disabled="!!editingId" />
                </label>

                <label>
                  Class
                  <select v-model="examClassId" :disabled="!!editingId">
                    <option value="">Choose class</option>
                    <option
                      v-for="c in classes"
                      :key="c.id"
                      :value="c.id"
                    >
                      {{ c.name }}
                    </option>
                  </select>
                </label>

                <article
                  v-for="(section, index) in sectionDrafts"
                  :key="index"
                >
                  <h2>Section {{ index + 1 }}</h2>

                  <label>
                    Section name
                    <input v-model="section.name" />
                  </label>

                  <label>
                    Question type
                    <select
                      v-model="section.type"
                      :disabled="!!editingId"
                    >
                      <option value="MCQ">Multiple choice A–J</option>
                      <option value="TF">True / False</option>
                    </select>
                  </label>

                  <label>
                    Answer key
                    <textarea
                      v-model="section.keyText"
                      placeholder="A,B,C,D,A"
                    ></textarea>
                  </label>

                  <div class="grid">
                    <label>
                      Correct-answer points
                      <input
                        v-model.number="section.points"
                        type="number"
                        min="0.01"
                        max="100"
                        step="0.01"
                      />
                    </label>

                    <label>
                      Wrong/multiple penalty
                      <input
                        v-model.number="section.penalty"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                      />
                    </label>
                  </div>

                  <button
                    v-if="!editingId && sectionDrafts.length > 1"
                    class="secondary"
                    @click="sectionDrafts.splice(index, 1)"
                  >
                    Remove section
                  </button>
                </article>

                <div class="actions">
                  <button
                    v-if="!editingId && sectionDrafts.length < 5"
                    class="secondary"
                    @click="sectionDrafts.push(emptySection())"
                  >
                    Add section
                  </button>

                  <button @click="saveExam">Save exam / key</button>
                </div>

                <p>
                  Maximum 100 questions per section. Blank answers earn zero.
                  Negative final totals are clamped to zero.
                </p>
              </section>

              <section v-if="tab === 'exam' && exam">
                <h1>{{ exam.title }}</h1>

                <div class="stats">
                  <article>
                    <strong>{{ roster.length }}</strong>
                    <span>Students</span>
                  </article>

                  <article>
                    <strong>{{ examResults.length }}</strong>
                    <span>Graded</span>
                  </article>

                  <article>
                    <strong>{{ roster.length - examResults.length }}</strong>
                    <span>Not graded</span>
                  </article>
                </div>

                <p>
                  {{ items.length }} questions ·
                  Key version {{ exam.version }}
                </p>

                <div class="actions">
                  <button @click="tab = 'scan'">Scan papers</button>
                  <button @click="printSheet">Print / share sheet</button>
                  <button @click="tab = 'reports'">Results</button>
                  <button class="secondary" @click="editKey">
                    Edit answer key
                  </button>
                </div>

                <p v-if="staleResults.length">
                  {{ staleResults.length }} results need regrading.
                </p>
              </section>

              <template v-if="tab === 'scan'">
                <section v-if="!exam">
                  <p>Open an exam from the Exams tab first.</p>
                </section>

                <section v-else>
                  <h1>Scan: {{ exam.title }}</h1>

                  <label>
                    Student
                    <select v-model="selectedStudentId">
                      <option value="">Choose student first</option>
                      <option
                        v-for="s in roster"
                        :key="s.id"
                        :value="s.id"
                      >
                        {{ s.number }} — {{ s.name }}
                      </option>
                    </select>
                  </label>

                  <p>
                    Changing the student clears the previous answer entry.
                  </p>

                  <div class="actions">
                    <button class="secondary" @click="resetEntry">
                      Manual entry
                    </button>

                    <button
                      v-if="!cameraActive"
                      @click="startCamera"
                    >
                      Start live camera
                    </button>

                    <button
                      v-else
                      @click="captureCameraFrame"
                    >
                      Capture paper
                    </button>

                    <button
                      v-if="cameraActive"
                      class="secondary"
                      @click="stopCamera"
                    >
                      Stop camera
                    </button>

                    <button
                      v-if="Capacitor.isNativePlatform()"
                      @click="takePhoto"
                    >
                      Take photo
                    </button>
                  </div>

                  <div v-if="cameraActive" class="camera-view">
                    <video
                      ref="cameraVideo"
                      autoplay
                      muted
                      playsinline
                      aria-label="Live answer sheet camera"
                    ></video>
                    <p>Place the full paper inside the camera view, then capture it.</p>
                  </div>

                  <label>
                    Upload photograph
                    <input
                      type="file"
                      accept="image/*"
                      @change="uploadPhoto"
                    />
                  </label>

                  <template v-if="photoUrl && original">
                    <p>
                      Tap marker centers:
                      top-left → top-right → bottom-right → bottom-left.
                    </p>

                    <p>Selected {{ corners.length }}/4.</p>

                    <div class="photo" @click="selectCorner">
                      <img
                        :src="photoUrl"
                        alt="Select answer-sheet corner markers"
                        draggable="false"
                      />

                      <span
                        v-for="(point, index) in corners"
                        :key="index"
                        class="marker"
                        :style="{
                          left: point.x / original.width * 100 + '%',
                          top: point.y / original.height * 100 + '%'
                        }"
                      >
                        {{ index + 1 }}
                      </span>
                    </div>

                    <div class="actions">
                      <button class="secondary" @click="resetCorners">
                        Reset corners
                      </button>

                      <button
                        :disabled="corners.length !== 4 || scanned"
                        @click="recognize"
                      >
                        Read bubbles
                      </button>
                    </div>
                  </template>

                  <img
                    v-if="previewUrl"
                    :src="previewUrl"
                    class="preview"
                    alt="Recognized answer sheet"
                  />

                  <h2>Review answers</h2>

                  <div class="answer-grid">
                    <label v-for="(item, index) in items" :key="index">
                      {{ index + 1 }}. {{ item.sectionName }}

                      <select
                        v-model="answers[index]"
                        @change="reviewed = false"
                      >
                        <option value="?">Uncertain — review</option>
                        <option value="">Blank</option>
                        <option value="MULTIPLE">Multiple marks</option>
                        <option
                          v-for="option in item.options"
                          :key="option"
                          :value="option"
                        >
                          {{ option }}
                        </option>
                      </select>
                    </label>
                  </div>

                  <p v-if="scorePreview" class="score">
                    {{ scorePreview.score }} /
                    {{ scorePreview.maxScore }}
                    · {{ scorePreview.percentage }}%
                  </p>

                  <p v-if="entryVersion !== exam.version">
                    The key changed. Start this entry again.
                  </p>

                  <label class="checkbox">
                    <input v-model="reviewed" type="checkbox" />
                    I checked the student and every answer against the paper.
                  </label>

                  <button :disabled="!canSave" @click="saveResult">
                    Save and prepare next paper
                  </button>
                </section>
              </template>

              <template v-if="tab === 'reports'">
                <section v-if="!exam">
                  <p>Open an exam first.</p>
                </section>

                <template v-else>
                  <section>
                    <h1>{{ exam.title }} — Results</h1>

                    <p>
                      Average for current-key results:
                      {{ average }}%
                    </p>

                    <p v-if="staleResults.length">
                      {{ staleResults.length }} results use an older key.
                      They are excluded from current analysis.
                    </p>

                    <div class="actions">
                      <button
                        :disabled="!staleResults.length"
                        @click="regradeResults"
                      >
                        Regrade outdated results
                      </button>

                      <button
                        :disabled="!currentResults.length || staleResults.length > 0"
                        @click="exportResults"
                      >
                        Export / share CSV
                      </button>
                    </div>

                    <div class="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Student</th>
                            <th>Score</th>
                            <th>Percentage</th>
                            <th>Key</th>
                          </tr>
                        </thead>

                        <tbody>
                          <tr v-for="r in examResults" :key="r.id">
                            <td>{{ r.studentNumber }} — {{ r.studentName }}</td>
                            <td>{{ r.score }}/{{ r.maxScore }}</td>
                            <td>{{ r.percentage }}%</td>
                            <td>{{ r.keyVersion }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section>
                    <h2>Question analysis</h2>

                    <p>
                      Based on {{ currentResults.length }}
                      results using the latest key.
                    </p>

                    <div class="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Question</th>
                            <th>Correct</th>
                            <th>Blank</th>
                            <th>Multiple</th>
                            <th>Other incorrect</th>
                          </tr>
                        </thead>

                        <tbody>
                          <tr v-for="row in analysis" :key="row.number">
                            <td>{{ row.number }}</td>
                            <td>{{ row.correct }}</td>
                            <td>{{ row.blank }}</td>
                            <td>{{ row.multiple }}</td>
                            <td>
                              {{
                                currentResults.length -
                                row.correct -
                                row.blank -
                                row.multiple
                              }}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                </template>
              </template>

              <section v-if="tab === 'settings'">
                <h1>Account</h1>
                <p>{{ user.email }}</p>
                <p>
                  This version requires internet for cloud saving.
                  Keep the app open until saving finishes.
                </p>
                <button @click="logout">Log out</button>
              </section>
            </template>
          </fieldset>
        </main>
      </ion-content>

      <ion-footer v-if="user">
        <nav>
          <button :disabled="busy" @click="tab = 'exams'">Exams</button>
          <button :disabled="busy" @click="tab = 'classes'">Classes</button>
          <button :disabled="busy" @click="tab = 'scan'">Scan</button>
          <button :disabled="busy" @click="tab = 'reports'">Reports</button>
          <button :disabled="busy" @click="tab = 'settings'">Account</button>
        </nav>
      </ion-footer>
    </ion-page>
  </ion-app>
</template>