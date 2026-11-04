import React from 'react';
import { createRoot } from 'react-dom/client';
import './app/styles/globals.css';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/app/theme/ThemeProvider';
import AndroidSetupWizard from '@/app/setup/AndroidSetupWizard';
import ServerConnectionGate from '@/app/setup/ServerConnectionGate';
import LessonWorkspace from '@/app/App';
import TeacherDashboard from '@/app/teacher/TeacherDashboard';
import type { Lesson, Room, School } from '@/app/session/types';
import type { SlideElement } from '@/app/presentation/Slides';
import { type Task } from '@/app/tasks/tasks';
import { DEFAULT_PRESENTATION_SOURCE } from '@/app/presentation/presentationSource';

const screen = new URL(location.href).searchParams.get('screen') || 'setup-language';

const school: School = { id: 'school-demo', name: 'ОСШГ №11', createdAt: Date.now() };
const room: Room = { id: 'room-demo', schoolId: school.id, name: '10Б • интерактивная доска', createdAt: Date.now() };
const lesson: Lesson = { id: 'lesson-demo', schoolId: school.id, roomId: room.id, grade: 11, subjectId: 'algebra', status: 'active', startedAt: Date.now(), updatedAt: Date.now(), endedAt: null };


function DemoTeacherDashboard() {
  const slides = JSON.parse(localStorage.getItem('practice.slides') || '[]');
  const tasks = JSON.parse(localStorage.getItem('practice.tasks') || '[]');
  return <TeacherDashboard
    subjectId="algebra"
    tasks={tasks}
    slides={slides}
    presentationSource={DEFAULT_PRESENTATION_SOURCE}
    onChangeTasks={() => {}}
    onChangeSlides={() => {}}
    onChangePresentationSource={() => {}}
    siteBackground={{mode:'solid', color:'#0A0E14', gradient:'', image:''}}
    onChangeSiteBackground={() => {}}
    onClose={() => {}}
    fullPage
  />;
}

function DemoWorkspace({ tab }: { tab?: string }) {
  localStorage.setItem('practice.activeTab', tab || 'board');
  localStorage.setItem('practice.slides', JSON.stringify([
    { id: 1, title: 'Первообразная и интеграл', content: '', notes: 'Разбор определения', backgroundColor: '#0A0E14', elements: [
      { id: 'bg', type: 'shape', shape: 'round', x: 44, y: 38, w: 872, h: 464, fill: '#101827', strokeColor: '#263244', strokeWidth: 1 },
      { id: 't', type: 'text', x: 78, y: 58, w: 805, h: 62, text: 'Первообразная функции', fontSize: 34, color: '#F4F7FB', fontFamily: 'Montserrat', fontWeight: 'bold', align: 'left' },
      { id: 'b1', type: 'text', x: 86, y: 150, w: 780, h: 58, text: '• Если \\(F\'(x)=f(x)\\), то F — первообразная функции f.', fontSize: 22, color: '#AAB7C4', fontFamily: 'Montserrat', align: 'left' },
      { id: 'm', type: 'math', x: 92, y: 240, w: 760, h: 90, latex: '\\int x^2 dx = \\frac{x^3}{3}+C', fallbackText: '∫ x² dx = x³/3 + C', fontSize: 34, color: '#F4F7FB', align: 'center', display: true },
      { id: 'b2', type: 'text', x: 86, y: 365, w: 780, h: 58, text: '• Урок собирается из учебника: текст, задания, слайды и проверка.', fontSize: 21, color: '#AAB7C4', fontFamily: 'Montserrat', align: 'left' },
    ] as SlideElement[] },
    { id: 2, title: 'Проверка решения', content: '', notes: '', backgroundColor: '#0A0E14', elements: [] },
  ]));
  localStorage.setItem('practice.tasks', JSON.stringify([
    { id: 1, title: 'Найдите первообразную', problem: 'Найдите \\(\\int x^2 dx\\)', answer: '\\(x^3/3+C\\)', kind: 'calc', tags: ['интеграл'] },
    { id: 2, title: 'Определение', problem: 'Что такое первообразная?', answer: 'F\'(x)=f(x)', kind: 'open', tags: ['теория'] },
  ] satisfies Task[]));
  return <LessonWorkspace school={school} room={room} lesson={lesson} boardProfile="analytical" onComplete={() => {}} onOpenHistory={() => {}} onChangeRoom={() => {}} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <ThemeProvider><I18nProvider>{children}</I18nProvider></ThemeProvider>;
}

if (screen === 'setup-language') {
  localStorage.clear();
  createRoot(document.getElementById('root')!).render(<Shell><AndroidSetupWizard onDone={() => {}} /></Shell>);
} else if (screen === 'setup-connect') {
  localStorage.clear(); localStorage.setItem('matrix.ui.locale','ru');
  createRoot(document.getElementById('root')!).render(<Shell><AndroidSetupWizard skipLanguage onDone={() => {}} /></Shell>);
} else if (screen === 'setup-offline') {
  localStorage.setItem('matrix.ui.locale','ru');
  createRoot(document.getElementById('root')!).render(<Shell><ServerConnectionGate checking={false} serverName="Главный сервер 1 макбук" result={{ok:false, reason:'server-found-unreachable', serverName:'Главный сервер 1 макбук', serverUrl:'https://192.168.1.20:8443', checks:{savedAddress:'failed', discovery:'ok', identity:'skipped', backend:'failed'}} as any} onRetry={() => {}} onConfigure={() => {}} /></Shell>);
} else if (screen === 'teacher') {
  createRoot(document.getElementById('root')!).render(<Shell><DemoWorkspace tab="teacher" /></Shell>);
} else if (screen === 'teacher-direct') {
  localStorage.setItem('practice.slides', JSON.stringify([{id:1,title:'Первообразная и интеграл',content:'',notes:'',backgroundColor:'#0A0E14',elements:[{id:'bg',type:'shape',shape:'round',x:44,y:38,w:872,h:464,fill:'#101827',strokeColor:'#263244',strokeWidth:1},{id:'t',type:'text',x:78,y:58,w:805,h:62,text:'Первообразная функции',fontSize:34,color:'#F4F7FB',fontFamily:'Montserrat',fontWeight:'bold',align:'left'},{id:'b1',type:'text',x:86,y:150,w:780,h:58,text:'• Если \(F\'(x)=f(x)\), то F — первообразная функции f.',fontSize:22,color:'#AAB7C4',fontFamily:'Montserrat',align:'left'},{id:'m',type:'math',x:92,y:240,w:760,h:90,latex:'\\int x^2 dx = \\frac{x^3}{3}+C',fallbackText:'∫ x² dx = x³/3 + C',fontSize:34,color:'#F4F7FB',align:'center',display:true}]}]));
  localStorage.setItem('practice.tasks', JSON.stringify([{id:1,title:'Найдите первообразную',problem:'Найдите \(\\int x^2 dx\)',answer:'\(x^3/3+C\)',kind:'calc',tags:['интеграл']}]))
  createRoot(document.getElementById('root')!).render(<Shell><DemoTeacherDashboard /></Shell>);
} else if (screen === 'lesson') {
  createRoot(document.getElementById('root')!).render(<Shell><DemoWorkspace tab="board" /></Shell>);
} else if (screen === 'presentation') {
  createRoot(document.getElementById('root')!).render(<Shell><DemoWorkspace tab="slides" /></Shell>);
} else {
  createRoot(document.getElementById('root')!).render(<Shell><DemoWorkspace /></Shell>);
}
