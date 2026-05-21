# ALTAI Proje Fikirleri

> IsanAgent v0.9.0 kapasiteleri uzerinden olusturulmustur.
> Son guncelleme: 2026-05-20

---

## IsanAgent Altyapi Ozeti

| Kategori | Detay |
|----------|-------|
| **Toplam Tool** | 44 (16 builtin + 13 execution + 3 ML domain + 3 workflow + 8 sub-agent + 1 skill) |
| **Execution Provider** | 4 (Local, Jupyter, SSH, Colab MCP) |
| **Channel** | 4 (Terminal, API/HTTP, Slack, Email) + **Tauri** (ALTAI icin ozel) |
| **Sub-agent** | 3 hazir profil (researcher, coder, evaluator) + custom tanim |
| **Memory** | SQLite FTS5 ile full-text search, short-term + long-term reflection |
| **Skill Sistemi** | SKILL.md dosyalarindan dinamik yukleme, `always` modu, gereksinim kontrolu |
| **Doom Loop** | SHA-256 hash ile tekrar eden tool call tespiti + otomatik duzeltme |
| **Cron** | SQLite'da persist edilen zamanlanmis gorevler |

### Tool Envanteri (Referans)

<details>
<summary>Tum 44 tool listesi (tiklayarak ac)</summary>

**Dosya Sistemi:** `read_file`, `write_file`, `edit_file`, `list_dir`, `glob_files`, `search_text`

**Shell & Runtime:** `exec`, `python_run`

**Web & Arastirma:** `web_search`, `web_fetch`, `arxiv_search`, `arxiv_fetch`, `hf_hub_file_fetch`

**Execution Plane:** `execution_session_create`, `execution_run`, `execution_run_background`, `execution_job_status`, `execution_job_result`, `execution_read_log`, `execution_job_list`, `execution_job_cancel`, `execution_artifact_list`, `execution_cancel`, `execution_session_close`, `colab_mcp_tool_call`, `execution_env_info`

**Bellek & Zamanlama:** `search_memory`, `fetch_memory_by_date`, `cron`, `message`, `get_env`

**Workflow:** `todo_write`, `search_tools`, `ask_user`

**Sub-agent:** `subagent_spawn`, `subagent_plan_execute`, `task_list`, `task_get`, `task_cancel`, `task_history_list`, `agent_list`, `task_dashboard`

**Diger:** `git_worktree`, `load_skill_instructions`

</details>

### Execution Provider Detaylari

| Provider | Nasil Calisir | GPU | Persistent State |
|----------|--------------|-----|------------------|
| **Local** | `sh -c` veya Python subprocess/REPL | Host GPU | REPL modunda evet |
| **Jupyter** | HTTP + WebSocket, kernel bazli | Kernel'e bagli | Evet (kernel memory) |
| **SSH** | russh ile remote baglanti | Remote GPU | REPL modunda evet |
| **Colab MCP** | Browser MCP koprusu | Ucretsiz T4/TPU | Notebook session boyunca |

---

## Mevcut Agentlar (Tamamlandi)

| # | Agent | IsanAgent | Durum |
|---|-------|-----------|-------|
| 1 | **Paper Reproducer** | Evet | Eklendi |
| 2 | **Notebook Assistant** | Evet | Eklendi |
| 3 | **Dataset Generator** | Evet | Eklendi |

---

## Yeni Proje Fikirleri

### Proje 1: Model Fine-Tuner

**Tek satir:** Kullanici bir base model + dataset secer, agent training scriptini yazar, calistirir, sonuclari raporlar.

**Mimari:**

```
Kullanici Girdisi          IsanAgent Akisi
-----------------          ----------------
"Llama-3 8B'yi            1. hf_hub_file_fetch → config.json oku
 SFT dataset ile          2. execution_env_info → GPU/RAM kontrol
 fine-tune et"            3. execution_session_create (local/ssh/colab)
                          4. execution_run → pilot (1 epoch, kucuk batch)
                          5. execution_run_background → full training
                          6. execution_job_status → progress takip
                          7. execution_artifact_list → checkpoint'ler
                          8. Sonuc raporu + karsilastirma tablosu
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `hf_hub_file_fetch` | Model config, tokenizer config, README okuma |
| `execution_env_info` | GPU varligini, Python versiyonunu kontrol |
| `execution_session_create` | Local/SSH/Jupyter/Colab session baslatma |
| `execution_run` | Pilot training (kisa, senkron) |
| `execution_run_background` | Full training (background job) |
| `execution_job_status` | Training progress sorgu |
| `execution_job_result` | Final metrikler (loss, accuracy) |
| `execution_artifact_list` | Checkpoint dosyalari, log'lar |
| `web_search` | Best practices arastirma (learning rate, batch size) |
| `arxiv_search` | Fine-tuning teknikleri icin paper arama |
| `todo_write` | Training pipeline asamalarini izleme |
| `subagent_spawn` | Paralel: biri train ederken digeri eval yapar |

**Ozel Yetenekler:**
- **Auto-promote:** 120 saniyeyi gecen `execution_run` otomatik olarak background job'a donusur
- **Colab MCP:** Ucretsiz T4 GPU uzerinde fine-tuning (Google hesabi ile)
- **SSH Provider:** Remote sunucuda A100/H100 uzerinde training
- **Checkpoint recovery:** `execution_artifact_list` ile kaydedilmis checkpoint'ten devam

**Zorluk Derecesi:** Orta-Yuksek

**Gerekli Skill'ler (olusturulmali):**
- `ml-execution-preflight`: Training oncesi ortam kontrolu
- `oom-recovery-playbook`: Bellek tasma durumunda otomatik kurtarma (batch size kucultme, gradient accumulation)

---

### Proje 2: Research Agent (Derin Arastirma Asistani)

**Tek satir:** Bir ML konusu hakkinda cok katmanli derin arastirma yapar: paper, kod, benchmark, karsilastirma.

**Mimari:**

```
Kullanici: "Vision Transformer'larin                Sub-agent DAG:
 son 2 yildaki gelismeleri"
                                                    ┌─── researcher: arxiv_search
                                                    │    "ViT survey 2024-2026"
                                                    │
              subagent_plan_execute ───────────────> ├─── researcher: web_search
                                                    │    "state-of-art ViT benchmarks"
                                                    │
                                                    ├─── researcher: hf_hub_file_fetch
                                                    │    "top ViT model configs"
                                                    │
                                                    └─── evaluator: synthesize
                                                         Tum sonuclari birlestir
                                                         Celiskiler? Bilgi boslugu?
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `arxiv_search` | Paper kesfetme (30'a kadar sonuc) |
| `arxiv_fetch` | Tam paper icerigi (Markdown veya PDF cikartma) |
| `web_search` | Genel web arastirma (DuckDuckGo/Jina) |
| `web_fetch` | Blog, dokumantasyon, benchmark sayfasi okuma |
| `hf_hub_file_fetch` | Model card, config, tokenizer bilgisi |
| `subagent_spawn` | Paralel arastirma gorevleri |
| `subagent_plan_execute` | Siralama: kesfet → derinlestir → celiskileri kontrol → sentez |
| `search_memory` | Onceki session'lardan hatirla |
| `todo_write` | Arastirma asamalarini izle |
| `write_file` | Sonuc raporunu dosyaya kaydet |

**Sub-agent Akisi (plan_execute):**

```json
{
  "steps": [
    {
      "id": "discovery",
      "depends_on": [],
      "prompt": "arxiv_search + web_search ile son 2 yilin ViT paper'larini bul"
    },
    {
      "id": "deep_read",
      "depends_on": ["discovery"],
      "prompt": "En onemli 5 paper'i arxiv_fetch ile oku, methodoloji cikar"
    },
    {
      "id": "contradiction_check",
      "depends_on": ["deep_read"],
      "prompt": "Paper'lar arasindaki celiskileri bul, claim'leri karsilastir"
    },
    {
      "id": "synthesis",
      "depends_on": ["contradiction_check"],
      "prompt": "Tum bulgulari birlesik bir rapor olarak yaz"
    }
  ]
}
```

**Ozel Yetenekler:**
- **Bellek:** Arastirma sonuclari `session_summaries`'e kaydedilir, gelecek session'larda `search_memory` ile hatirlanir
- **Long-term reflection:** 60 saniyede bir calisan reflection engine, kisa vadeli ozetleri uzun vadeli kaliplara donusturur
- **Celiski tespiti:** Evaluator sub-agent farklı kaynaklardaki celiskileri saptar

**Zorluk Derecesi:** Orta

**Gerekli Skill'ler (olusturulmali):**
- `literature-to-recipe`: Paper'dan implementation recipe cikarma

---

### Proje 3: Experiment Tracker (Deney Yonetim Sistemi)

**Tek satir:** Birden fazla ML deneyini paralel calistirir, sonuclari karsilastirir, en iyi hyperparameter'lari onerir.

**Mimari:**

```
                        ┌── Job 1: lr=1e-4, bs=32 ──────┐
                        │                                 │
Kullanici:              ├── Job 2: lr=3e-4, bs=16 ──────┤──→ Karsilastirma
"3 farkli lr dene"      │                                 │    Tablosu
                        └── Job 3: lr=1e-3, bs=32 ──────┘
                             |                    |
                     execution_run_background   execution_job_status
                                                  (periyodik polling)
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `execution_session_create` | Her deney icin session |
| `execution_run_background` | Paralel training job'lari |
| `execution_job_list` | Tum job'larin durumu |
| `execution_job_status` | Tekil job progress |
| `execution_job_result` | Final metrikler |
| `execution_artifact_list` | Loss grafikleri, checkpoint'ler |
| `execution_read_log` | Training log'larini oku (satir bazli) |
| `execution_job_cancel` | Basarisiz deneyi durdur |
| `todo_write` | Deney pipeline durumunu goster |
| `write_file` | Sonuc raporunu dosyaya kaydet |
| `cron` | Zamanlanmis deney (orn: her gece retrain) |
| `subagent_spawn` | Biri train, digeri eval, ucuncusu report |

**Deney Karsilastirma Raporu Formati:**

```
| Deney | LR    | BS | Epoch | Val Loss | Val Acc | Durum    |
|-------|-------|----|-------|----------|---------|----------|
| exp-1 | 1e-4  | 32 | 10    | 0.342    | 91.2%   | Tamamlandi |
| exp-2 | 3e-4  | 16 | 10    | 0.298    | 93.1%   | Tamamlandi |
| exp-3 | 1e-3  | 32 | 7     | 0.891    | 45.3%   | Iptal      |

Oneri: exp-2 (lr=3e-4, bs=16) en iyi sonucu verdi.
```

**Ozel Yetenekler:**
- **Cron ile zamanlama:** `cron_expr` ile "her gece 02:00'de retrain" senaryosu
- **Auto-cancel:** Loss diverge ederse job otomatik iptal
- **Artifact yonetimi:** `.execution_artifacts/{session_id}/` altinda tum ciktilar (grafikler, CSV, checkpoint)
- **Wake-on-completion:** Background job bittiginde parent agent otomatik uyandirilir

**Zorluk Derecesi:** Orta

---

### Proje 4: ML Debugger (ML Hata Ayiklayici)

**Tek satir:** Training coktugunde veya loss dusmediginde root cause analizi yapar ve duzeltme onerir.

**Mimari:**

```
Kullanici: "Training crash ediyor,    Agent Akisi:
 CUDA out of memory"
                                      1. execution_read_log → hata mesajini oku
                                      2. search_text → kodda OOM noktasini bul
                                      3. read_file → model tanimini incele
                                      4. Analiz: batch_size x model_params x dtype = VRAM
                                      5. Oneri: batch_size=4, gradient_accumulation=8
                                      6. edit_file → config'i guncelle
                                      7. execution_run → test et
                                      8. Basarili? → Rapor. Basarisiz? → Doom loop engeli
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `execution_read_log` | Crash log'unu satir satir oku |
| `read_file` | Model kodu, config dosyalari |
| `search_text` | Hata mesajini codebase'de ara |
| `edit_file` | Config/kod duzeltmesi |
| `execution_run` | Fix'i test et |
| `web_search` | Hata mesajini internette ara |
| `arxiv_search` | Ilgili teknik paper (orn: mixed precision) |
| `glob_files` | Proje yapisini kesfet |
| `execution_env_info` | GPU/VRAM bilgisi |
| `todo_write` | Debug asamalarini izle |
| `subagent_spawn` | researcher: hata arastir, coder: fix yaz |

**Hata Kategorileri ve Otomatik Mudahale:**

| Hata Tipi | Tespit Yontemi | Otomatik Fix |
|-----------|---------------|--------------|
| **CUDA OOM** | "CUDA out of memory" log'da | batch_size kucult, grad accum artir |
| **NaN Loss** | "nan" veya "inf" loss degerinde | learning rate dusur, gradient clipping ekle |
| **Shape Mismatch** | "size mismatch" veya "expected X got Y" | Model layer boyutlarini kontrol et |
| **Import Error** | "ModuleNotFoundError" | `pip install` onerisi |
| **Convergence** | Loss 5 epoch boyunca dusmuyor | LR scheduler, warmup, data augmentation onerisi |

**Ozel Yetenekler:**
- **Doom loop korunmasi:** Ayni hatayi 3+ kez tekrarlarsa `[SYSTEM: DOOM LOOP DETECTED]` ile farkli strateji zorlar
- **OOM recovery playbook:** Skill olarak yuklenebilir, adim adim bellek optimizasyonu

**Zorluk Derecesi:** Orta-Yuksek

**Gerekli Skill'ler (olusturulmali):**
- `oom-recovery-playbook`: OOM durumunda adim adim kurtarma proseduru
- `scientific-python-debugging`: Python debugging best practices

---

### Proje 5: Codebase Analyst (ML Kod Analisti)

**Tek satir:** Mevcut bir ML projesini derinlemesine analiz eder: mimari, bagimliliklar, test durumu, performans sorunlari.

**Mimari:**

```
Kullanici: "Bu ML projesini analiz et"

  subagent_plan_execute:
  ┌───────────────────────────────────────────────────┐
  │ Step 1: researcher                                │
  │   glob_files → proje yapisi                       │
  │   read_file → README, requirements.txt, setup.py  │
  │   search_text → "import torch", "import tf"       │
  │                                                   │
  │ Step 2: coder                                     │
  │   read_file → model.py, train.py, data.py         │
  │   search_text → "class.*Model", "def forward"     │
  │   Mimari cikartma                                 │
  │                                                   │
  │ Step 3: evaluator                                 │
  │   search_text → "test_", "assert", "pytest"       │
  │   glob_files → tests/**/*.py                      │
  │   Kalite degerlendirme                            │
  └───────────────────────────────────────────────────┘

  Cikti: Yapilandirilmis analiz raporu
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `glob_files` | Proje yapisi haritalama |
| `read_file` | Kaynak kod, config, README |
| `search_text` | Pattern arama (import, class tanimi, test) |
| `list_dir` | Dizin icerik listesi |
| `subagent_spawn` | Paralel analiz (mimari, kalite, guvenlik) |
| `subagent_plan_execute` | Siralı analiz: kesfet → analiz → degerlendir |
| `write_file` | Raporu dosyaya kaydet |
| `web_search` | Kullanilan kutuphanelerin guncel versiyonlari |
| `hf_hub_file_fetch` | Kullanilan model'in orijinal config'i |
| `execution_run` | `pip list`, `pytest --co`, `pylint` calistirma |

**Rapor Ciktisi:**

```
## Proje Analizi: {proje_adi}

### Genel Bakis
- Framework: PyTorch 2.1
- Model Tipi: Vision Transformer (ViT-B/16)
- Dataset: ImageNet-1K subset

### Mimari
- Model: 86M parametre, 12 layer, 768 hidden
- Loss: CrossEntropyLoss
- Optimizer: AdamW (lr=1e-4, wd=0.01)

### Kod Kalitesi
- Test coverage: 23% (DUSUK)
- Linting hatalari: 47
- Type hint kullanimi: %12

### Potansiyel Sorunlar
- [ ] Data loader'da num_workers=0 (yavas)
- [ ] Mixed precision kullanilmiyor
- [ ] Checkpoint kaydi yok
- [ ] Reproducibility: seed set edilmemis

### Oneriler
1. num_workers=4 yap
2. torch.cuda.amp ekle
3. Her epoch sonunda checkpoint kaydet
4. random seed sabitle
```

**Zorluk Derecesi:** Dusuk-Orta

---

### Proje 6: Autonomous Training Pipeline (Otonom Egitim Hatti)

**Tek satir:** Zamanlanmis gorevlerle veri toplama → training → evaluation → raporlama pipeline'i.

**Mimari:**

```
Cron: Her gun 02:00                      Cron: Her hafta Pazar 06:00
         │                                         │
         ▼                                         ▼
  ┌──────────────┐                         ┌──────────────┐
  │ Veri Toplama  │                         │ Full Retrain  │
  │ web_fetch     │                         │ execution_run │
  │ arxiv_fetch   │──→ dataset.jsonl ──────>│ _background   │
  │ write_file    │                         │               │
  └──────────────┘                         └──────┬───────┘
                                                   │
                                                   ▼
                                           ┌──────────────┐
                                           │ Evaluation    │
                                           │ execution_run │
                                           │ Karsilastir   │
                                           └──────┬───────┘
                                                   │
                                                   ▼
                                           ┌──────────────┐
                                           │ Bildirim      │
                                           │ message       │
                                           │ (Slack/Email) │
                                           └──────────────┘
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `cron` | Zamanlanmis gorev tanimlama (veri toplama, training, eval) |
| `web_search` + `web_fetch` | Yeni veri kaynaklari toplama |
| `arxiv_search` + `arxiv_fetch` | Yeni paper'lar izleme |
| `execution_session_create` | Training ortami hazirlama |
| `execution_run_background` | Uzun sureli training |
| `execution_job_status` | Training izleme |
| `execution_artifact_list` | Checkpoint, log, grafik toplama |
| `message` | Slack/Email ile sonuc bildirimi |
| `write_file` | Veri seti, rapor kaydetme |
| `search_memory` | Onceki training sonuclarini hatirla |
| `todo_write` | Pipeline durumu izleme |

**Cron Ornekleri:**

```
# Her gun gece 2'de yeni veri topla
cron_expr: "0 2 * * *"
message: "Yeni training verisi topla ve dataset.jsonl'e ekle"

# Her hafta pazar sabah 6'da retrain
cron_expr: "0 6 * * 0"
message: "Full model retraining baslat, onceki checkpoint'ten devam et"

# Her ay 1'inde benchmark karsilastir
cron_expr: "0 10 1 * *"
message: "Aylik benchmark raporu olustur, onceki aylarla karsilastir"
```

**Ozel Yetenekler:**
- **Webhook token:** Cron job'lari disaridan tetiklenebilir (CI/CD entegrasyonu)
- **Multi-channel bildirim:** Training bittikten sonra Slack + Email ile sonuc gonder
- **Wake-on-completion:** `wake_on_job_terminal` ile background job bitince agent otomatik uyanir

**Zorluk Derecesi:** Yuksek

---

### Proje 7: HuggingFace Hub Manager

**Tek satir:** Hugging Face Hub uzerindeki modelleri/datasetleri yonetir, karsılastırır, dokumante eder.

**Mimari:**

```
Kullanici: "Llama-3 ile Mistral'i    Agent Akisi:
 karsılastır"
                                     1. hf_hub_file_fetch → Llama-3/config.json
                                     2. hf_hub_file_fetch → Mistral/config.json
                                     3. hf_hub_file_fetch → Llama-3/README.md
                                     4. hf_hub_file_fetch → Mistral/README.md
                                     5. web_search → benchmark sonuclari
                                     6. Karsilastirma tablosu olustur
                                     7. write_file → raporu kaydet
```

**Kullanilan Toollar:**

| Tool | Amac |
|------|------|
| `hf_hub_file_fetch` | config.json, README.md, tokenizer_config.json okuma |
| `web_search` | Benchmark sonuclari, community tartismalari |
| `web_fetch` | Model card detaylari, leaderboard sayfalari |
| `write_file` | Model card, dataset card yazma |
| `subagent_spawn` | Her model icin paralel bilgi toplama |
| `search_memory` | Daha once incelenen modelleri hatirla |

**Cikti Formati:**

```
## Model Karsilastirma: Llama-3-8B vs Mistral-7B

| Ozellik        | Llama-3-8B    | Mistral-7B     |
|----------------|---------------|----------------|
| Parametre      | 8.03B         | 7.24B          |
| Context        | 8192          | 32768          |
| Vocab Size     | 128256        | 32000          |
| Hidden Size    | 4096          | 4096           |
| Layers         | 32            | 32             |
| Attention      | GQA (8 KV)    | GQA (8 KV)     |
| MMLU           | 66.6          | 62.5           |
| HumanEval      | 62.2          | 32.8           |
| Lisans         | Llama 3 CLA   | Apache 2.0     |
```

**Zorluk Derecesi:** Dusuk

---

## Gelismis Proje Fikirleri (Ileri Seviye)

### Proje 8: Multi-Agent ML Workshop

**Tek satir:** Birden fazla sub-agent'in koordineli calistigi tam bir ML projesi: data → train → evaluate → deploy.

```
coordinator (ana agent)
  ├── researcher: paper + benchmark arastirma
  ├── data_engineer (coder): veri hazirlama
  ├── trainer (coder): model training
  ├── evaluator: sonuc degerlendirme
  └── writer (coder): rapor + model card yazma
```

**subagent_plan_execute ile DAG:**
1. `researcher` → Konu arastir, best practices bul
2. `data_engineer` → Dataset hazirlama (researcher sonuclarina bagli)
3. `trainer` → Model training (dataset'e bagli)
4. `evaluator` → Sonuclari degerlendir (training'e bagli)
5. `writer` → Rapor + model card yaz (tum sonuclara bagli)

**Zorluk Derecesi:** Cok Yuksek

---

### Proje 9: Paper-to-Production Pipeline

**Tek satir:** Paper Reproducer + Fine-Tuner + Experiment Tracker birlesimi: paper oku → implement → train → evaluate → karsılastır.

```
Kullanici: "Bu paper'i reproduce et ve CIFAR-100'de test et"

  Paper Reproducer → Kod uret
       │
       ▼
  Experiment Tracker → 3 farkli config dene
       │
       ▼
  ML Debugger → Hatalari duzelt
       │
       ▼
  Research Agent → Sonuclari paper ile karsılastır
       │
       ▼
  Rapor: "Paper claim: 94.2% acc. Bizim sonuc: 93.8% acc. Fark analizi: ..."
```

**Zorluk Derecesi:** Cok Yuksek

---

### Proje 10: Scheduled Model Monitor

**Tek satir:** Production'daki modeli izler, performans duserse alarm verir, otomatik retrain tetikler.

```
Cron: Her saat
  │
  ▼
  execution_run → inference_test.py
  │
  ├── Accuracy > threshold? → OK, log yaz
  │
  └── Accuracy < threshold? → message (Slack alarm)
                              → cron: retrain job tetikle
```

**Zorluk Derecesi:** Yuksek

---

## Oncelik Matrisi

| Oncelik | Proje | Zorluk | Etki | Neden Oncelikli |
|---------|-------|--------|------|-----------------|
| **1** | Model Fine-Tuner | Orta-Yuksek | Cok Yuksek | Execution harness + Colab = ucretsiz GPU training, en buyuk differentiator |
| **2** | Research Agent | Orta | Yuksek | Sub-agent + bellek sistemi hazir, hemen calisir |
| **3** | Experiment Tracker | Orta | Yuksek | Background jobs + artifacts zaten var, fine-tuner ile dogal tamamlayici |
| **4** | HuggingFace Hub Manager | Dusuk | Orta | En kolay implementasyon, hf_hub_file_fetch hazir |
| **5** | ML Debugger | Orta-Yuksek | Yuksek | Doom loop + OOM playbook unique ozellikler, ama skill yazilmali |
| **6** | Codebase Analyst | Dusuk-Orta | Orta | Mevcut toollarla hemen yapilabilir |
| **7** | Training Pipeline | Yuksek | Cok Yuksek | Cron + background jobs + multi-channel = guclu ama karmasik |
| **8** | Multi-Agent Workshop | Cok Yuksek | Cok Yuksek | Tum agent yeteneklerinin birlesimi, showcase proje |
| **9** | Paper-to-Production | Cok Yuksek | Cok Yuksek | Diger agent'larin birlesimi, son asama |
| **10** | Model Monitor | Yuksek | Yuksek | Production monitoring, cron + alerting gerekli |

---

## Implementasyon Notu

Her yeni agent icin gereken minimum degisiklikler:

1. **`src/modules/ai/lib/agents.ts`** — `BUILTIN_AGENTS` array'ine agent tanimi ekle, `ISANAGENT_AGENT_IDS`'e ID ekle, `AgentIconId`'ye icon ekle
2. **`src/modules/ai/components/AgentSwitcher.tsx`** — `ICONS` map'ine icon ekle
3. **`src/modules/ai/components/AgentIntroCard.tsx`** — `AGENT_WORKFLOWS`'a workflow tanimi ekle
4. **Opsiyonel:** IsanAgent workspace'ine skill SKILL.md dosyasi ekle

Yeni tool yazmaya gerek yok — tum projeler IsanAgent'in mevcut 44 tool'u ile calisir.
