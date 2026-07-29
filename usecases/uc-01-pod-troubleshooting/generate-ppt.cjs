const PptxGenJS = require("pptxgenjs");
const path = require("path");
const pptx = new PptxGenJS();
pptx.author = "TCS Agentic AI Platform";
pptx.title = "TCS Agentic AI — Complete Platform Overview";
pptx.layout = "LAYOUT_WIDE";

const C = {
  darkNavy:"0F172A",navy:"1E293B",hBlue:"1E40AF",tcsBlue:"2563EB",
  lBlue:"DBEAFE",pBlue:"EFF6FF",
  aiPurple:"7C3AED",lPurple:"EDE9FE",
  autoGreen:"059669",lGreen:"D1FAE5",dGreen:"166534",
  userAmber:"D97706",lAmber:"FEF3C7",
  valCyan:"0891B2",lCyan:"CFFAFE",
  gatePink:"9D174D",lPink:"FCE7F3",
  secRed:"DC2626",lRed:"FEE2E2",
  predOrange:"EA580C",lOrange:"FFEDD5",
  white:"FFFFFF",tDark:"1E293B",tMed:"475569",tLight:"94A3B8",
  arrowGray:"64748B",bgLight:"F8FAFC",
};

const hLine = (s) => { s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:13.33,h:0.06,fill:{color:C.tcsBlue}}); };
const dkSlide = () => { const s=pptx.addSlide(); s.background={fill:C.darkNavy}; hLine(s); s.addShape(pptx.ShapeType.rect,{x:0,y:7.42,w:13.33,h:0.08,fill:{color:C.tcsBlue}}); return s; };
const ltSlide = () => { const s=pptx.addSlide(); s.background={fill:C.white}; hLine(s); return s; };

// ═══════ SLIDE 1: TITLE ═══════
let s = dkSlide();
s.addText("TCS AGENTIC AI",{x:0.8,y:0.9,w:11,h:1.0,fontSize:44,fontFace:"Calibri",bold:true,color:C.white});
s.addShape(pptx.ShapeType.rect,{x:0.8,y:2.0,w:3.5,h:0.06,fill:{color:C.tcsBlue}});
s.addText("Intelligent Platform Operations\nfor Enterprise Kubernetes at Scale",{x:0.8,y:2.3,w:11,h:1.2,fontSize:24,fontFace:"Calibri",color:C.tLight,lineSpacingMultiple:1.3});
s.addText("AI-Powered Troubleshooting  •  Autonomous Cluster Upgrades\nPredictive Intelligence  •  Security & Compliance  •  Multi-Cluster Federation",{x:0.8,y:3.8,w:10,h:1.0,fontSize:14,fontFace:"Calibri",italic:true,color:C.tcsBlue,lineSpacingMultiple:1.5});

const stats=[{v:"4",l:"Use Cases"},{v:"13",l:"AI Agents"},{v:"59",l:"Services"},{v:"41",l:"Tools"},{v:"50+",l:"Health Checks"}];
for(let i=0;i<stats.length;i++){
  const x=0.6+i*2.5;
  s.addShape(pptx.ShapeType.rect,{x,y:5.3,w:2.2,h:1.1,fill:{color:"1E293B"},line:{color:"334155",width:1},rectRadius:0.1});
  s.addText(stats[i].v,{x,y:5.3,w:2.2,h:0.6,fontSize:24,fontFace:"Calibri",bold:true,color:C.tcsBlue,align:"center",valign:"middle"});
  s.addText(stats[i].l,{x,y:5.9,w:2.2,h:0.4,fontSize:10,fontFace:"Calibri",color:C.tLight,align:"center"});
}
s.addText("Hackathon Demo  |  TCS Agentic AI Engineering",{x:0.8,y:6.7,w:8,h:0.4,fontSize:12,fontFace:"Calibri",color:C.tLight});


// ═══════ SLIDE 2: THE PROBLEM ═══════
s = ltSlide();
s.addText("Platform Operations at Scale — The Challenge",{x:0.6,y:0.25,w:12,h:0.6,fontSize:26,fontFace:"Calibri",bold:true,color:C.darkNavy});
s.addShape(pptx.ShapeType.rect,{x:0.6,y:0.85,w:2.5,h:0.04,fill:{color:C.secRed}});

const probs=[
  {title:"Reactive, Not Proactive",desc:"Teams react to incidents after users are impacted. No prediction, no prevention, no early warning system.",icon:"🔥"},
  {title:"14–40 Hours per Upgrade",desc:"Manual pre-checks, change requests, monitoring, documentation — multiplied by every cluster, every cycle.",icon:"⏱"},
  {title:"SRE Toil & Burnout",desc:"Senior engineers babysit upgrades, manually correlate logs, fill ServiceNow forms — instead of building.",icon:"😰"},
  {title:"Security Blind Spots",desc:"CIS benchmarks checked sporadically. Image CVEs discovered after deployment. RBAC drift goes unnoticed.",icon:"🔓"},
  {title:"Tool Sprawl",desc:"15+ CLI commands, 5+ dashboards, multiple ticketing systems — no single pane of glass, no unified workflow.",icon:"🔀"},
  {title:"No Audit Trail",desc:"Before/after evidence rarely captured. Change requests incomplete. Compliance auditors find gaps.",icon:"📋"},
];
for(let i=0;i<probs.length;i++){
  const col=i%3,row=Math.floor(i/3);
  const px=0.3+col*4.25,py=1.1+row*2.6;
  s.addShape(pptx.ShapeType.rect,{x:px,y:py,w:4.0,h:2.3,fill:{color:"FEF2F2"},line:{color:"FECACA",width:1},rectRadius:0.1});
  s.addText(probs[i].icon,{x:px,y:py+0.1,w:4.0,h:0.45,fontSize:22,align:"center"});
  s.addText(probs[i].title,{x:px+0.15,y:py+0.58,w:3.7,h:0.4,fontSize:13,fontFace:"Calibri",bold:true,color:C.secRed,align:"center"});
  s.addText(probs[i].desc,{x:px+0.15,y:py+1.05,w:3.7,h:1.05,fontSize:10,fontFace:"Calibri",color:C.tMed,align:"center"});
}
s.addShape(pptx.ShapeType.rect,{x:0.3,y:6.6,w:12.7,h:0.5,fill:{color:C.darkNavy},rectRadius:0.08});
s.addText("What if one AI platform could handle all of this — with natural language, full automation, and complete audit trail?",{x:0.3,y:6.6,w:12.7,h:0.5,fontSize:14,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});


// ═══════ SLIDE 3: PLATFORM OVERVIEW ═══════
s = ltSlide();
s.addText("TCS Agentic AI — Platform Overview",{x:0.6,y:0.25,w:12,h:0.55,fontSize:26,fontFace:"Calibri",bold:true,color:C.darkNavy});
s.addShape(pptx.ShapeType.rect,{x:0.6,y:0.8,w:2.5,h:0.04,fill:{color:C.autoGreen}});

const useCases=[
  {num:"UC-01",title:"Intelligent Pod\nTroubleshooting",desc:"Natural language → AI diagnosis → automated fix → ServiceNow lifecycle",metric:"MTTR: 45 seconds",metricSub:"(was 2-4 hours)",color:C.tcsBlue,bg:C.lBlue},
  {num:"UC-02",title:"Autonomous Cluster\nUpgrade",desc:"One sentence → 50+ pre-checks → ITSM → execute → post-assess → close CR",metric:"< 10 min human time",metricSub:"(was 14-40 hours)",color:C.autoGreen,bg:C.lGreen},
  {num:"UC-03",title:"Predictive Intelligence\n& Anomaly Detection",desc:"AI predicts OOM, disk, restarts, capacity — before failures happen",metric:"7 prediction types",metricSub:"30-min rolling analysis",color:C.predOrange,bg:C.lOrange},
  {num:"UC-04",title:"Security & Compliance\nGovernance",desc:"CIS benchmarks, image CVE scanning, RBAC audit, policy enforcement",metric:"A-F compliance grade",metricSub:"Continuous scanning",color:C.secRed,bg:C.lRed},
];
for(let i=0;i<4;i++){
  const uc=useCases[i];
  const x=0.3+i*3.25,y=1.1;
  s.addShape(pptx.ShapeType.rect,{x,y,w:3.0,h:4.2,fill:{color:uc.bg},line:{color:uc.color,width:1.5},rectRadius:0.12});
  s.addShape(pptx.ShapeType.rect,{x:x+0.6,y:y+0.15,w:1.8,h:0.3,fill:{color:uc.color},rectRadius:0.04});
  s.addText(uc.num,{x:x+0.6,y:y+0.15,w:1.8,h:0.3,fontSize:10,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});
  s.addText(uc.title,{x:x+0.1,y:y+0.6,w:2.8,h:0.7,fontSize:13,fontFace:"Calibri",bold:true,color:uc.color,align:"center"});
  s.addText(uc.desc,{x:x+0.12,y:y+1.4,w:2.76,h:1.0,fontSize:9.5,fontFace:"Calibri",color:C.tMed,align:"center"});
  s.addShape(pptx.ShapeType.rect,{x:x+0.2,y:y+2.6,w:2.6,h:0.9,fill:{color:C.white},rectRadius:0.08});
  s.addText(uc.metric,{x:x+0.2,y:y+2.65,w:2.6,h:0.5,fontSize:14,fontFace:"Calibri",bold:true,color:uc.color,align:"center",valign:"middle"});
  s.addText(uc.metricSub,{x:x+0.2,y:y+3.1,w:2.6,h:0.3,fontSize:9,fontFace:"Calibri",color:C.tLight,align:"center"});
}

// Platform capabilities row
const platCaps=[
  {title:"Natural Language Interface",desc:"19+ phrasings understood",c:C.lAmber},
  {title:"13 Specialist AI Agents",desc:"A2A protocol compatible",c:C.lPurple},
  {title:"Hub-Spoke Multi-Cluster",desc:"Federated across 50+ clusters",c:C.lCyan},
  {title:"ServiceNow ITSM",desc:"Full incident & CR lifecycle",c:C.lGreen},
];
for(let i=0;i<4;i++){
  const x=0.3+i*3.25,y=5.6;
  s.addShape(pptx.ShapeType.rect,{x,y,w:3.0,h:1.0,fill:{color:platCaps[i].c},rectRadius:0.08});
  s.addText(platCaps[i].title,{x:x+0.1,y:y+0.05,w:2.8,h:0.45,fontSize:11,fontFace:"Calibri",bold:true,color:C.tDark,align:"center",valign:"middle"});
  s.addText(platCaps[i].desc,{x:x+0.1,y:y+0.5,w:2.8,h:0.4,fontSize:9,fontFace:"Calibri",color:C.tMed,align:"center"});
}


// ═══════ SLIDE 4: ARCHITECTURE ═══════
s = ltSlide();
s.addText("Platform Architecture",{x:0.5,y:0.2,w:12,h:0.5,fontSize:24,fontFace:"Calibri",bold:true,color:C.darkNavy});

// Top layer: User Interface
s.addShape(pptx.ShapeType.rect,{x:0.3,y:0.85,w:12.7,h:0.8,fill:{color:C.lAmber},line:{color:C.userAmber,width:1.5},rectRadius:0.1});
s.addText("USER INTERFACE LAYER",{x:0.5,y:0.85,w:2.5,h:0.35,fontSize:9,fontFace:"Calibri",bold:true,color:C.userAmber});
const uiItems=["AI Chat\n(Natural Language)","Dashboard\n(13+ Widgets)","Intelligence\n(Predictions)","Audit\n(Compliance Trail)","Cluster Picker\n(Multi-Cluster)"];
for(let i=0;i<5;i++){
  s.addShape(pptx.ShapeType.rect,{x:0.5+i*2.5,y:1.05,w:2.2,h:0.5,fill:{color:C.white},rectRadius:0.06});
  s.addText(uiItems[i],{x:0.5+i*2.5,y:1.05,w:2.2,h:0.5,fontSize:8,fontFace:"Calibri",bold:true,color:C.tDark,align:"center",valign:"middle"});
}

// Down arrow
s.addText("▼",{x:6.2,y:1.68,w:0.9,h:0.25,fontSize:14,color:C.arrowGray,align:"center",fontFace:"Arial"});

// AI Engine layer
s.addShape(pptx.ShapeType.rect,{x:0.3,y:1.95,w:12.7,h:1.6,fill:{color:C.lPurple},line:{color:C.aiPurple,width:1.5},rectRadius:0.1});
s.addText("AI ENGINE",{x:0.5,y:1.95,w:2.5,h:0.35,fontSize:9,fontFace:"Calibri",bold:true,color:C.aiPurple});
const aiItems=[
  ["NLU Engine","Intent classification\n19+ phrasings"],
  ["LLM Service","Azure OpenAI\nHybrid diagnosis"],
  ["Predictive Intel","OOM/disk/restart\nforecasting"],
  ["Pod Doctor","Smart memory\ncalculation"],
  ["RCA Engine","Root cause\nanalysis"],
];
for(let i=0;i<5;i++){
  s.addShape(pptx.ShapeType.rect,{x:0.5+i*2.5,y:2.3,w:2.2,h:1.05,fill:{color:C.white},rectRadius:0.06});
  s.addText(aiItems[i][0],{x:0.5+i*2.5,y:2.32,w:2.2,h:0.35,fontSize:9,fontFace:"Calibri",bold:true,color:C.aiPurple,align:"center"});
  s.addText(aiItems[i][1],{x:0.5+i*2.5,y:2.65,w:2.2,h:0.6,fontSize:8,fontFace:"Calibri",color:C.tMed,align:"center"});
}

// Down arrow
s.addText("▼",{x:6.2,y:3.58,w:0.9,h:0.25,fontSize:14,color:C.arrowGray,align:"center",fontFace:"Arial"});

// 13 Agents layer
s.addShape(pptx.ShapeType.rect,{x:0.3,y:3.85,w:12.7,h:1.3,fill:{color:C.lGreen},line:{color:C.autoGreen,width:1.5},rectRadius:0.1});
s.addText("13 SPECIALIST AI AGENTS (A2A Protocol)",{x:0.5,y:3.85,w:5,h:0.35,fontSize:9,fontFace:"Calibri",bold:true,color:C.autoGreen});
const agents=["Diagnostics\n& Healing","Upgrade\nLifecycle","Security\n& Compliance","Proactive\nIntelligence","ITSM &\nChange Mgmt","Multi-Cluster\n& ACM","Observability\n& Monitoring","Workload\nManagement","CI/CD\n& GitOps","Networking\n& Mesh","Backup\n& DR","Infrastructure\n& Virt","Cluster\nOperations"];
for(let i=0;i<13;i++){
  const x=0.4+i*0.975;
  s.addShape(pptx.ShapeType.rect,{x,y:4.2,w:0.88,h:0.8,fill:{color:C.white},rectRadius:0.05});
  s.addText(agents[i],{x,y:4.2,w:0.88,h:0.8,fontSize:6.5,fontFace:"Calibri",bold:true,color:C.tDark,align:"center",valign:"middle"});
}

// Down arrow
s.addText("▼",{x:6.2,y:5.18,w:0.9,h:0.25,fontSize:14,color:C.arrowGray,align:"center",fontFace:"Arial"});

// Integration layer
s.addShape(pptx.ShapeType.rect,{x:0.3,y:5.45,w:6.1,h:1.05,fill:{color:C.lCyan},line:{color:C.valCyan,width:1.5},rectRadius:0.1});
s.addText("INTEGRATIONS",{x:0.5,y:5.45,w:2.5,h:0.3,fontSize:9,fontFace:"Calibri",bold:true,color:C.valCyan});
const intItems=["ServiceNow\nITSM","Prometheus\nMetrics","OpenShift\nAPI","Azure\nOpenAI"];
for(let i=0;i<4;i++){
  s.addShape(pptx.ShapeType.rect,{x:0.5+i*1.45,y:5.75,w:1.3,h:0.6,fill:{color:C.white},rectRadius:0.05});
  s.addText(intItems[i],{x:0.5+i*1.45,y:5.75,w:1.3,h:0.6,fontSize:8,fontFace:"Calibri",bold:true,color:C.tDark,align:"center",valign:"middle"});
}

// Hub-Spoke
s.addShape(pptx.ShapeType.rect,{x:6.9,y:5.45,w:6.1,h:1.05,fill:{color:C.lBlue},line:{color:C.tcsBlue,width:1.5},rectRadius:0.1});
s.addText("HUB-SPOKE MULTI-CLUSTER FEDERATION",{x:7.1,y:5.45,w:5,h:0.3,fontSize:9,fontFace:"Calibri",bold:true,color:C.tcsBlue});
s.addShape(pptx.ShapeType.ellipse,{x:8.8,y:5.8,w:1.4,h:0.55,fill:{color:C.tcsBlue}});
s.addText("HUB",{x:8.8,y:5.8,w:1.4,h:0.55,fontSize:10,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});
const spokes=["Spoke 1\nCluster A","Spoke 2\nCluster B","Spoke 3\nCluster C"];
for(let i=0;i<3;i++){
  s.addShape(pptx.ShapeType.ellipse,{x:10.5+i*0.85,y:5.85,w:0.75,h:0.45,fill:{color:C.lBlue},line:{color:C.tcsBlue,width:1}});
  s.addText(spokes[i],{x:10.5+i*0.85,y:5.85,w:0.75,h:0.45,fontSize:6,fontFace:"Calibri",bold:true,color:C.tcsBlue,align:"center",valign:"middle"});
}

// Footer
s.addShape(pptx.ShapeType.rect,{x:0.3,y:6.7,w:12.7,h:0.35,fill:{color:C.darkNavy},rectRadius:0.06});
s.addText("59 Services  |  41 Tools  |  13 AI Agents  |  4 UI Views  |  Hub-Spoke Federation  |  Full ITSM Lifecycle  |  A2A Protocol",{x:0.3,y:6.7,w:12.7,h:0.35,fontSize:10,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});


// ═══════ SLIDE 5: UC-01 SUMMARY ═══════
s = ltSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0.06,w:13.33,h:0.55,fill:{color:C.tcsBlue}});
s.addText("UC-01  |  Intelligent Pod Troubleshooting & Remediation",{x:0.5,y:0.06,w:12,h:0.55,fontSize:20,fontFace:"Calibri",bold:true,color:C.white,valign:"middle"});

// Flow
const ucSteps=[
  {title:"Ask Question",sub:"\"Why is my pod crashing?\"",color:C.userAmber,bg:C.lAmber},
  {title:"NLU + Pod Discovery",sub:"Intent → pod → namespace",color:C.aiPurple,bg:C.lPurple},
  {title:"Collect Telemetry",sub:"Logs + Events + Metrics",color:C.autoGreen,bg:C.lGreen},
  {title:"Hybrid AI Diagnosis",sub:"Rules + LLM root cause",color:C.aiPurple,bg:C.lPurple},
  {title:"Smart Fix Proposal",sub:"Data-driven remediation",color:C.aiPurple,bg:C.lPurple},
  {title:"ServiceNow INC",sub:"Auto-created + populated",color:C.autoGreen,bg:C.lGreen},
  {title:"Apply & Validate",sub:"Before/After evidence",color:C.valCyan,bg:C.lCyan},
  {title:"Incident Resolved",sub:"MTTR: 45 seconds",color:C.autoGreen,bg:C.lGreen},
];
for(let i=0;i<8;i++){
  const x=0.15+i*1.63,step=ucSteps[i];
  s.addShape(pptx.ShapeType.rect,{x,y:0.85,w:1.48,h:1.4,fill:{color:step.bg},line:{color:step.color,width:1.5},rectRadius:0.08});
  s.addShape(pptx.ShapeType.ellipse,{x:x+0.55,y:0.88,w:0.35,h:0.35,fill:{color:step.color}});
  s.addText(String(i+1),{x:x+0.55,y:0.88,w:0.35,h:0.35,fontSize:11,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});
  s.addText(step.title,{x:x+0.04,y:1.28,w:1.4,h:0.4,fontSize:9,fontFace:"Calibri",bold:true,color:step.color,align:"center"});
  s.addText(step.sub,{x:x+0.04,y:1.65,w:1.4,h:0.45,fontSize:8,fontFace:"Calibri",color:C.tMed,align:"center"});
  if(i<7) s.addText("▶",{x:x+1.44,y:1.3,w:0.22,h:0.3,fontSize:10,color:C.arrowGray,align:"center",fontFace:"Arial"});
}

// Key features
const kf1=[
  ["19+ NL phrasings","Rule + LLM diagnosis","smartMemoryLimit()","Before/After metrics"],
  ["Pod name extraction","OOMKilled detection","Risk-assessed fixes","ServiceNow lifecycle"],
];
for(let r=0;r<2;r++) for(let c=0;c<4;c++){
  const x=0.3+c*3.2,y=2.55+r*0.45;
  s.addShape(pptx.ShapeType.rect,{x,y,w:3.0,h:0.38,fill:{color:C.pBlue},rectRadius:0.04});
  s.addText("✓  "+kf1[r][c],{x:x+0.08,y,w:2.9,h:0.38,fontSize:9,fontFace:"Calibri",color:C.tcsBlue,valign:"middle"});
}

// Impact metrics
const imp1=[{v:"45s",l:"MTTR"},{v:"99%",l:"Reduction"},{v:"20",l:"Auto Steps"},{v:"3",l:"Human Steps"},{v:"0",l:"CLI Commands"}];
for(let i=0;i<5;i++){
  const x=0.3+i*2.55;
  s.addShape(pptx.ShapeType.rect,{x,y:3.7,w:2.3,h:1.05,fill:{color:C.darkNavy},rectRadius:0.08});
  s.addText(imp1[i].v,{x,y:3.72,w:2.3,h:0.6,fontSize:24,fontFace:"Calibri",bold:true,color:C.tcsBlue,align:"center",valign:"middle"});
  s.addText(imp1[i].l,{x,y:4.3,w:2.3,h:0.35,fontSize:10,fontFace:"Calibri",color:C.tLight,align:"center"});
}


// ═══════ SLIDE 6: UC-02 SUMMARY ═══════
s = ltSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0.06,w:13.33,h:0.55,fill:{color:C.autoGreen}});
s.addText("UC-02  |  Autonomous Cluster Upgrade Automation",{x:0.5,y:0.06,w:12,h:0.55,fontSize:20,fontFace:"Calibri",bold:true,color:C.white,valign:"middle"});

const uc2Steps=[
  {title:"User Request",sub:"\"Upgrade to 4.14.28\"",color:C.userAmber,bg:C.lAmber},
  {title:"Version Validate",sub:"Path + channel check",color:C.aiPurple,bg:C.lPurple},
  {title:"50+ Pre-Checks",sub:"Operators, etcd, certs...",color:C.aiPurple,bg:C.lPurple},
  {title:"Blocker Analysis",sub:"Risk score + remediation",color:C.aiPurple,bg:C.lPurple},
  {title:"ServiceNow CR",sub:"Auto-created + reports",color:C.autoGreen,bg:C.lGreen},
  {title:"Approval Gate",sub:"Auto-poll until approved",color:C.gatePink,bg:C.lPink},
  {title:"Execute & Monitor",sub:"CVO + operators + nodes",color:C.autoGreen,bg:C.lGreen},
  {title:"Post-Assess Close",sub:"Report + auto-close CR",color:C.autoGreen,bg:C.lGreen},
];
for(let i=0;i<8;i++){
  const x=0.15+i*1.63,step=uc2Steps[i];
  s.addShape(pptx.ShapeType.rect,{x,y:0.85,w:1.48,h:1.4,fill:{color:step.bg},line:{color:step.color,width:1.5},rectRadius:0.08});
  s.addShape(pptx.ShapeType.ellipse,{x:x+0.55,y:0.88,w:0.35,h:0.35,fill:{color:step.color}});
  s.addText(String(i+1),{x:x+0.55,y:0.88,w:0.35,h:0.35,fontSize:11,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});
  s.addText(step.title,{x:x+0.04,y:1.28,w:1.4,h:0.4,fontSize:9,fontFace:"Calibri",bold:true,color:step.color,align:"center"});
  s.addText(step.sub,{x:x+0.04,y:1.65,w:1.4,h:0.45,fontSize:8,fontFace:"Calibri",color:C.tMed,align:"center"});
  if(i<7) s.addText("▶",{x:x+1.44,y:1.3,w:0.22,h:0.3,fontSize:10,color:C.arrowGray,align:"center",fontFace:"Arial"});
}

const kf2=[
  ["50+ health checks in parallel","Smart completion: 3-gate verification","PDF + HTML assessment reports","Duplicate upgrade prevention"],
  ["EUS-to-EUS path validation","15-second CVO progress polling","Auto-close CR with evidence","Hub-spoke multi-cluster ready"],
];
for(let r=0;r<2;r++) for(let c=0;c<4;c++){
  const x=0.3+c*3.2,y=2.55+r*0.45;
  s.addShape(pptx.ShapeType.rect,{x,y,w:3.0,h:0.38,fill:{color:"ECFDF5"},rectRadius:0.04});
  s.addText("✓  "+kf2[r][c],{x:x+0.08,y,w:2.9,h:0.38,fontSize:9,fontFace:"Calibri",color:C.autoGreen,valign:"middle"});
}

const imp2=[{v:"~95%",l:"Time Saved"},{v:"< 10 min",l:"Human Time"},{v:"50+",l:"Health Checks"},{v:"13",l:"Auto Steps"},{v:"1",l:"Human Step"}];
for(let i=0;i<5;i++){
  const x=0.3+i*2.55;
  s.addShape(pptx.ShapeType.rect,{x,y:3.7,w:2.3,h:1.05,fill:{color:C.darkNavy},rectRadius:0.08});
  s.addText(imp2[i].v,{x,y:3.72,w:2.3,h:0.6,fontSize:24,fontFace:"Calibri",bold:true,color:C.autoGreen,align:"center",valign:"middle"});
  s.addText(imp2[i].l,{x,y:4.3,w:2.3,h:0.35,fontSize:10,fontFace:"Calibri",color:C.tLight,align:"center"});
}


// ═══════ SLIDE 7: UC-03 PREDICTIVE INTELLIGENCE ═══════
s = ltSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0.06,w:13.33,h:0.55,fill:{color:C.predOrange}});
s.addText("UC-03  |  Predictive Intelligence & Anomaly Detection",{x:0.5,y:0.06,w:12,h:0.55,fontSize:20,fontFace:"Calibri",bold:true,color:C.white,valign:"middle"});

s.addText("\"AI that predicts failures before they happen — and tells you exactly what to do about it\"",{x:0.5,y:0.8,w:12,h:0.4,fontSize:13,fontFace:"Calibri",italic:true,color:C.tMed,align:"center"});

// Prediction types
const predictions=[
  {title:"OOM Prediction",desc:"Forecasts memory exhaustion using 30-min rolling trends + 24h historical data",icon:"💾",time:"30 min advance warning"},
  {title:"Disk Full Prediction",desc:"Detects storage consumption trends and alerts before PVCs fill up",icon:"💿",time:"Hours advance warning"},
  {title:"Restart Acceleration",desc:"Identifies pods with accelerating restart patterns — early CrashLoop detection",icon:"🔄",time:"Pattern-based detection"},
  {title:"Capacity Exhaustion",desc:"Forecasts when cluster CPU/memory capacity will be exceeded",icon:"📊",time:"Capacity planning"},
  {title:"Operator Degradation",desc:"Detects gradual operator health decline before full degradation",icon:"⚙",time:"Progressive monitoring"},
  {title:"Event Escalation",desc:"Identifies warning event storms that indicate emerging cluster issues",icon:"⚡",time:"Threshold-based alerts"},
];
for(let i=0;i<6;i++){
  const col=i%3,row=Math.floor(i/3);
  const x=0.3+col*4.25,y=1.35+row*1.75;
  const p=predictions[i];
  s.addShape(pptx.ShapeType.rect,{x,y,w:4.0,h:1.5,fill:{color:C.lOrange},line:{color:C.predOrange,width:1},rectRadius:0.1});
  s.addText(p.icon+"  "+p.title,{x:x+0.1,y:y+0.05,w:3.8,h:0.35,fontSize:12,fontFace:"Calibri",bold:true,color:"9A3412"});
  s.addText(p.desc,{x:x+0.1,y:y+0.4,w:3.8,h:0.55,fontSize:9,fontFace:"Calibri",color:C.tMed});
  s.addShape(pptx.ShapeType.rect,{x:x+0.1,y:y+1.0,w:2.4,h:0.28,fill:{color:"FED7AA"},rectRadius:0.04});
  s.addText(p.time,{x:x+0.1,y:y+1.0,w:2.4,h:0.28,fontSize:8,fontFace:"Calibri",bold:true,color:C.predOrange,align:"center",valign:"middle"});
}

// Proactive Agent + Cost Advisor
s.addText("Also Includes:",{x:0.5,y:5.0,w:2,h:0.35,fontSize:11,fontFace:"Calibri",bold:true,color:C.tDark});

s.addShape(pptx.ShapeType.rect,{x:0.3,y:5.35,w:6.2,h:1.2,fill:{color:C.lPurple},line:{color:C.aiPurple,width:1},rectRadius:0.1});
s.addText("🤖  Proactive Agent — Continuous Anomaly Detection",{x:0.5,y:5.38,w:5.8,h:0.3,fontSize:11,fontFace:"Calibri",bold:true,color:C.aiPurple});
s.addText("Auto-detects: pod crashes, OOM kills, image pull failures, node pressure, cert expiry, operator degradation, PVC capacity, resource quota, event storms, config changes, image vulnerabilities\nScans: 60s main cycle | 5m app changes | 30m image vulns",{x:0.5,y:5.72,w:5.8,h:0.75,fontSize:8,fontFace:"Calibri",color:C.tMed});

s.addShape(pptx.ShapeType.rect,{x:6.8,y:5.35,w:6.2,h:1.2,fill:{color:C.lGreen},line:{color:C.autoGreen,width:1},rectRadius:0.1});
s.addText("💰  Cost & Efficiency Advisor",{x:7.0,y:5.38,w:5.8,h:0.3,fontSize:11,fontFace:"Calibri",bold:true,color:C.autoGreen});
s.addText("Identifies: over-provisioned workloads (request > 3× P95 usage), under-provisioned (usage > 90% limit), missing CPU/memory limits\nData source: 24h P95 quantile from Prometheus vs declared requests/limits",{x:7.0,y:5.72,w:5.8,h:0.75,fontSize:8,fontFace:"Calibri",color:C.tMed});

s.addShape(pptx.ShapeType.rect,{x:0.3,y:6.75,w:12.7,h:0.35,fill:{color:C.darkNavy},rectRadius:0.06});
s.addText("SHIFT LEFT:  Detect problems before users notice  →  Prevent incidents instead of reacting to them",{x:0.3,y:6.75,w:12.7,h:0.35,fontSize:11,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});


// ═══════ SLIDE 8: UC-04 SECURITY & COMPLIANCE ═══════
s = ltSlide();
s.addShape(pptx.ShapeType.rect,{x:0,y:0.06,w:13.33,h:0.55,fill:{color:C.secRed}});
s.addText("UC-04  |  Security & Compliance Governance",{x:0.5,y:0.06,w:12,h:0.55,fontSize:20,fontFace:"Calibri",bold:true,color:C.white,valign:"middle"});

const secCaps=[
  {title:"CIS Benchmark Scanning",desc:"CIS-5.1 RBAC, CIS-5.2 Pod Security, CIS-5.3 Network, CIS-5.4 Secrets, CIS-5.5 Images\n\n0-100 penalty scoring with A-F grade\nPrivileged containers, root execution, hostNetwork/PID/IPC, resource limits, probes, NetworkPolicies",color:C.secRed,bg:C.lRed},
  {title:"Image Vulnerability Scanner",desc:"Auto-detects Quay CSO or static analysis fallback\n\nCVSS scoring: Critical (9.0-10.0), High (7.0-8.9), Medium (4.0-6.9), Low (0.1-3.9)\nFixable count, image age, compliance score (signed, SBOM, digest pinned, trusted registry)",color:C.secRed,bg:C.lRed},
  {title:"RBAC Audit & Pod Security",desc:"\"Who can\" — find subjects capable of specific actions\nList all bindings with subjects, verbs, resources\n\nPod security audit: privileged mode, root execution, capabilities, limits\nNetwork policy coverage analysis",color:C.aiPurple,bg:C.lPurple},
  {title:"Policy Engine & SCC Advisor",desc:"Enforceable policies: required-labels, forbidden-registries, required-limits, required-probes, max-replicas, custom-rego\n\nSCC advisor: explains assignment, identifies over-privileged workloads, recommends least-privilege SCC",color:C.aiPurple,bg:C.lPurple},
];
for(let i=0;i<4;i++){
  const col=i%2,row=Math.floor(i/2);
  const x=0.3+col*6.5,y=0.85+row*2.5;
  const sc=secCaps[i];
  s.addShape(pptx.ShapeType.rect,{x,y,w:6.2,h:2.2,fill:{color:sc.bg},line:{color:sc.color,width:1.2},rectRadius:0.1});
  s.addText(sc.title,{x:x+0.15,y:y+0.08,w:5.9,h:0.35,fontSize:13,fontFace:"Calibri",bold:true,color:sc.color});
  s.addText(sc.desc,{x:x+0.15,y:y+0.45,w:5.9,h:1.65,fontSize:9,fontFace:"Calibri",color:C.tMed,lineSpacingMultiple:1.2});
}

// Audit Trail
s.addShape(pptx.ShapeType.rect,{x:0.3,y:5.95,w:12.7,h:0.8,fill:{color:"F1F5F9"},line:{color:C.tLight,width:1},rectRadius:0.1});
s.addText("📋  Audit View UI — Complete Compliance Dashboard",{x:0.5,y:5.95,w:5,h:0.3,fontSize:11,fontFace:"Calibri",bold:true,color:C.tDark});
s.addText("CIS score ring visualization  |  Category breakdown  |  Severity/status filters  |  Scan history  |  Framework mapping  |  90-day event log  |  Change request tracking  |  Query analytics",{x:0.5,y:6.3,w:12,h:0.4,fontSize:9,fontFace:"Calibri",color:C.tMed});

s.addShape(pptx.ShapeType.rect,{x:0.3,y:6.95,w:12.7,h:0.3,fill:{color:C.darkNavy},rectRadius:0.06});
s.addText("ENTERPRISE READY:  SOC2 / ISO 27001 / CIS Kubernetes Benchmark — continuous compliance, not periodic audits",{x:0.3,y:6.95,w:12.7,h:0.3,fontSize:10,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});


// ═══════ SLIDE 9: WHY DIFFERENT ═══════
s = ltSlide();
s.addText("Why TCS Agentic AI?",{x:0.6,y:0.25,w:12,h:0.6,fontSize:28,fontFace:"Calibri",bold:true,color:C.darkNavy});
s.addShape(pptx.ShapeType.rect,{x:0.6,y:0.85,w:2.5,h:0.04,fill:{color:C.tcsBlue}});

const diffs=[
  {left:"Traditional Monitoring",right:"TCS Agentic AI",items:[
    ["Alert after failure","Predict before failure"],
    ["15+ CLI commands","Natural language conversation"],
    ["Rules-only diagnosis","Hybrid AI (rules + LLM)"],
    ["Manual fix + hope","Data-driven fix + evidence"],
    ["Separate ticketing","Integrated ITSM lifecycle"],
    ["Single cluster view","Multi-cluster federation"],
    ["Periodic security audits","Continuous compliance scanning"],
    ["Reactive escalation","Proactive anomaly detection"],
  ]},
];

// Table header
s.addShape(pptx.ShapeType.rect,{x:0.5,y:1.15,w:5.8,h:0.4,fill:{color:C.secRed},rectRadius:0.06});
s.addText("Traditional Approach",{x:0.5,y:1.15,w:5.8,h:0.4,fontSize:12,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});
s.addText("→",{x:6.3,y:1.15,w:0.7,h:0.4,fontSize:20,fontFace:"Calibri",bold:true,color:C.arrowGray,align:"center",valign:"middle"});
s.addShape(pptx.ShapeType.rect,{x:7.0,y:1.15,w:5.8,h:0.4,fill:{color:C.autoGreen},rectRadius:0.06});
s.addText("TCS Agentic AI",{x:7.0,y:1.15,w:5.8,h:0.4,fontSize:12,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});

const items=diffs[0].items;
for(let i=0;i<items.length;i++){
  const y=1.65+i*0.58;
  const bg=i%2===0?C.white:"F8FAFC";
  s.addShape(pptx.ShapeType.rect,{x:0.5,y,w:5.8,h:0.5,fill:{color:i%2===0?"FEF2F2":"FEE2E2"},rectRadius:0.04});
  s.addText("✗  "+items[i][0],{x:0.7,y,w:5.4,h:0.5,fontSize:11,fontFace:"Calibri",color:"991B1B",valign:"middle"});
  s.addText("→",{x:6.3,y,w:0.7,h:0.5,fontSize:14,fontFace:"Calibri",color:C.arrowGray,align:"center",valign:"middle"});
  s.addShape(pptx.ShapeType.rect,{x:7.0,y,w:5.8,h:0.5,fill:{color:i%2===0?"ECFDF5":"D1FAE5"},rectRadius:0.04});
  s.addText("✓  "+items[i][1],{x:7.2,y,w:5.4,h:0.5,fontSize:11,fontFace:"Calibri",bold:true,color:C.dGreen,valign:"middle"});
}

s.addShape(pptx.ShapeType.rect,{x:0.5,y:6.45,w:12.3,h:0.7,fill:{color:C.darkNavy},rectRadius:0.1});
s.addText("Not just monitoring. Not just alerting. Not just automation.\nAn AI-native platform that understands, predicts, acts, and proves it.",{x:0.5,y:6.45,w:12.3,h:0.7,fontSize:13,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle",lineSpacingMultiple:1.4});


// ═══════ SLIDE 10: COMBINED 5-MIN DEMO ═══════
s = ltSlide();
s.addText("Combined Demo Flow — 5 Minutes",{x:0.5,y:0.2,w:12,h:0.55,fontSize:26,fontFace:"Calibri",bold:true,color:C.darkNavy});

const demoFlow=[
  {time:"0:00–0:30",phase:"Platform Overview",what:"Show dashboard with 13+ widgets — health, topology, alerts, at-risk pods.\n\"Single pane of glass across all clusters. Everything an SRE needs, powered by AI.\"",color:C.tcsBlue,bg:C.lBlue},
  {time:"0:30–1:00",phase:"UC-01: Ask a Question",what:"Type: \"Why is my pod mlflow-server crashing?\" → AI diagnoses OOMKilled in 10 seconds.\n\"Plain English. No kubectl. Root cause + evidence in seconds.\"",color:C.userAmber,bg:C.lAmber},
  {time:"1:00–1:45",phase:"UC-01: Fix & Evidence",what:"Click Apply Fix. Show before/after: 512Mi→2Gi, 19→0 restarts. ServiceNow auto-closed.\n\"45-second MTTR. Full audit trail. Before/after proof for every change.\"",color:C.autoGreen,bg:C.lGreen},
  {time:"1:45–2:30",phase:"UC-02: Upgrade Cluster",what:"Type: \"Upgrade to 4.14.28\" → 50+ pre-checks → ServiceNow CR auto-created.\n\"What takes 14-40 hours manually? One sentence. Full ITSM compliance.\"",color:C.autoGreen,bg:C.lGreen},
  {time:"2:30–3:15",phase:"UC-03: Predictive Intel",what:"Switch to Intelligence tab. Show predictions: OOM warning, disk trend, restart acceleration.\n\"AI doesn't just react — it predicts. 30-minute advance warning before failures hit.\"",color:C.predOrange,bg:C.lOrange},
  {time:"3:15–4:00",phase:"UC-04: Security Scan",what:"Show Audit tab: CIS compliance score, image vulnerabilities, RBAC findings.\n\"Continuous compliance. Not periodic audits. A-F grading. Enterprise-ready governance.\"",color:C.secRed,bg:C.lRed},
  {time:"4:00–4:30",phase:"Architecture & Scale",what:"Show multi-cluster picker, 13 agents. \"Hub-spoke federation. 50+ clusters. 13 specialist AI agents.\nEach agent discoverable via A2A protocol — they can collaborate.\"",color:C.aiPurple,bg:C.lPurple},
  {time:"4:30–5:00",phase:"Close Strong",what:"\"4 use cases. 13 agents. 59 services. Natural language in, full lifecycle out.\nFrom reactive to predictive. From manual to autonomous. That's TCS Agentic AI.\"",color:C.tcsBlue,bg:C.lBlue},
];
for(let i=0;i<demoFlow.length;i++){
  const d=demoFlow[i],y=0.85+i*0.78;
  s.addShape(pptx.ShapeType.rect,{x:0.25,y,w:1.1,h:0.68,fill:{color:d.bg},line:{color:d.color,width:1},rectRadius:0.06});
  s.addText(d.time,{x:0.25,y:y+0.02,w:1.1,h:0.35,fontSize:8,fontFace:"Calibri",bold:true,color:d.color,align:"center",valign:"middle"});
  s.addText(d.phase.split(":")[0],{x:0.25,y:y+0.36,w:1.1,h:0.26,fontSize:7,fontFace:"Calibri",bold:true,color:d.color,align:"center"});
  s.addText(d.phase,{x:1.5,y,w:2.3,h:0.68,fontSize:10,fontFace:"Calibri",bold:true,color:C.tDark,valign:"middle"});
  s.addText(d.what,{x:3.7,y,w:9.3,h:0.68,fontSize:8.5,fontFace:"Calibri",color:C.tMed,valign:"middle"});
}

s.addShape(pptx.ShapeType.rect,{x:0.25,y:7.15,w:12.8,h:0.22,fill:{color:C.darkNavy},rectRadius:0.04});
s.addText("TIP:  Pause after each \"wow moment\" — let it sink in.  The speed IS the demo.  End with the architecture for depth.",{x:0.25,y:7.13,w:12.8,h:0.26,fontSize:8,fontFace:"Calibri",bold:true,color:C.white,align:"center",valign:"middle"});


// ═══════ SLIDE 11: COMBINED IMPACT ═══════
s = dkSlide();
s.addText("Combined Platform Impact",{x:0.6,y:0.3,w:12,h:0.7,fontSize:32,fontFace:"Calibri",bold:true,color:C.white});

const combMetrics=[
  {v:"4",l:"Production Use Cases",sub:"Troubleshoot • Upgrade • Predict • Secure",c:C.tcsBlue},
  {v:"13",l:"Specialist AI Agents",sub:"A2A protocol • Self-discovering",c:C.aiPurple},
  {v:"95%+",l:"Automation Coverage",sub:"Human-in-loop only for approvals",c:C.autoGreen},
  {v:"100%",l:"Audit Trail",sub:"Every action evidenced & traceable",c:C.valCyan},
];
for(let i=0;i<4;i++){
  const x=0.4+i*3.2;
  s.addShape(pptx.ShapeType.rect,{x,y:1.3,w:2.9,h:2.4,fill:{color:"1E293B"},line:{color:combMetrics[i].c,width:1.5},rectRadius:0.12});
  s.addText(combMetrics[i].v,{x,y:1.4,w:2.9,h:0.9,fontSize:44,fontFace:"Calibri",bold:true,color:combMetrics[i].c,align:"center",valign:"middle"});
  s.addText(combMetrics[i].l,{x,y:2.35,w:2.9,h:0.5,fontSize:14,fontFace:"Calibri",bold:true,color:C.white,align:"center"});
  s.addText(combMetrics[i].sub,{x,y:2.85,w:2.9,h:0.6,fontSize:10,fontFace:"Calibri",color:C.tLight,align:"center"});
}

// Use case impact row
const ucImpact=[
  {uc:"UC-01: Troubleshooting",before:"2-4 hours",after:"45 seconds",saved:"99%"},
  {uc:"UC-02: Cluster Upgrade",before:"14-40 hours",after:"< 10 minutes",saved:"95%"},
  {uc:"UC-03: Prediction",before:"Reactive (post-failure)",after:"30-min advance warning",saved:"Prevention"},
  {uc:"UC-04: Security",before:"Periodic manual audits",after:"Continuous A-F scoring",saved:"Real-time"},
];

const tH=["Use Case","Without AI","With TCS Agentic AI","Improvement"];
for(let i=0;i<4;i++){
  const x=0.4+i*3.2;
  s.addShape(pptx.ShapeType.rect,{x,y:4.15,w:2.9,h:0.35,fill:{color:"334155"},rectRadius:0.04});
  s.addText(tH[i],{x,y:4.15,w:2.9,h:0.35,fontSize:9,fontFace:"Calibri",bold:true,color:C.tLight,align:"center",valign:"middle"});
}
for(let r=0;r<4;r++){
  const u=ucImpact[r];
  const vals=[u.uc,u.before,u.after,u.saved];
  const colors=[C.white,C.secRed,C.autoGreen,C.autoGreen];
  for(let c=0;c<4;c++){
    const x=0.4+c*3.2,y=4.55+r*0.42;
    s.addShape(pptx.ShapeType.rect,{x,y,w:2.9,h:0.38,fill:{color:"1E293B"},line:{color:"334155",width:0.5}});
    s.addText(vals[c],{x,y,w:2.9,h:0.38,fontSize:9,fontFace:"Calibri",bold:c>0,color:colors[c],align:"center",valign:"middle"});
  }
}


// ═══════ SLIDE 12: THANK YOU ═══════
s = dkSlide();
s.addText("TCS AGENTIC AI",{x:0,y:1.2,w:13.33,h:1.0,fontSize:44,fontFace:"Calibri",bold:true,color:C.white,align:"center"});
s.addShape(pptx.ShapeType.rect,{x:5.4,y:2.3,w:2.5,h:0.06,fill:{color:C.tcsBlue}});
s.addText("Intelligent Platform Operations for Enterprise Kubernetes",{x:0,y:2.6,w:13.33,h:0.6,fontSize:18,fontFace:"Calibri",color:C.tLight,align:"center"});
s.addText("Troubleshoot  •  Upgrade  •  Predict  •  Secure",{x:0,y:3.4,w:13.33,h:0.5,fontSize:16,fontFace:"Calibri",bold:true,color:C.tcsBlue,align:"center"});
s.addText("From Reactive to Predictive\nFrom Manual to Autonomous\nFrom Fragmented to Unified",{x:0,y:4.3,w:13.33,h:1.2,fontSize:20,fontFace:"Calibri",color:C.white,align:"center",lineSpacingMultiple:1.6});
s.addText("Thank You",{x:0,y:5.8,w:13.33,h:0.8,fontSize:28,fontFace:"Calibri",color:C.white,align:"center"});
s.addText("TCS Agentic AI Engineering",{x:0,y:6.7,w:13.33,h:0.4,fontSize:13,fontFace:"Calibri",color:C.tLight,align:"center"});


const outPath=path.join(__dirname, "TCS-Agentic-AI-UC01-Pod-Troubleshooting.pptx");
pptx.writeFile({fileName:outPath}).then(()=>console.log("Master PPT created:",outPath));
