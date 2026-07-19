# IsanAgent geliştirme planı — güncel ve uygulanabilir

> 2026-07-19'da çalışma ağacı ve kullanılan crate rev'iyle yeniden uzlaştırıldı.
> `[crate]` değişiklikleri `altaidevorg/isanagent` upstream'ine; `[altai]`
> değişiklikleri bu repoya gider. Crate pin'i artık `2f22e59` upstream rev'idir;
> fork/upstream hedefi açık karar değildir.

## Mevcut durum

- MCP stdio istemcisi, dinamik `ToolRegistry` kaydı, instance fingerprint'i ve
  Settings arayüzü bu çalışma ağacında zaten uygulanmış durumda. ITEM 2 sıfırdan
  yazılmayacak; mevcut uygulamanın uyumluluk ve güvenlik boşlukları kapatılacak.
- `.isanagentignore` crate rev'inde bulunuyor. ITEM 7 yeni özellik değil,
  uygulama entegrasyonunun doğrulamasıdır.
- `ask_user` ile shell onayı çalışıyor; `write_file` ve `edit_file` için aynı
  güvenlik sınırı henüz yok. En yüksek öncelik ITEM 1'dir.
- Checkpoint store process-global/set-once. ALTAI, workspace değişiminde geçerli
  kalması için app-level checkpoint kökü kullanıyor; timeline tasarımı bu
  gerçeği korumalıdır.

---

## ITEM 1 — Güvenli edit permission gate

**Hedef:** `ask` modunda `write_file` ve `edit_file`, kullanıcının gördüğü
değişiklik onaylanmadan çalışmaz. `auto-edit` ve `bypass` sessiz uygulanır.
`plan` modunda mutasyon anlamlı bir hata ile engellenir.

### Zorunlu tasarım sözleşmesi

1. **[crate] Merkezi gate + tool preflight.** Gate dispatch katmanında kalır;
   fakat generic `Tool` nesnesi dosya yolu ve hedef içeriği bilemez. Bu yüzden
   mutate tool'ları ortak bir `preview_mutation(args)` preflight sözleşmesi
   uygular. Preflight şunları döndürür:
   - canonical, workspace-relative path;
   - gösterim için sınırlanmış unified diff / before-after;
   - onay anındaki hedef dosyanın hash'i (yoksa "absent");
   - display truncation bilgisi.
2. **[crate] TOCTOU koruması.** Onaydan sonra execute, preflight hash'iyle
   karşılaştırılır. Dosya değişmişse yazmaz; model yeni preview üretir. Bu,
   kullanıcının onayladığı diff ile gerçek yazının aynı olmasını sağlar.
3. **[crate] Gizlilik ve sınırlar.** Ham dosya içeriği model mesajına veya
   kalıcı telemetry'ye konmaz. UI metadata'sına yalnızca sınırlandırılmış diff
   gider; büyük dosyalar için toplam boyut/hunk sınırı vardır. Gizli dosyalar
   (`.env` vb.) için değerleri maskeleme veya ekstra onay politikası açıkça
   uygulanır.
4. **[crate] Politika.** `ResolvedEditPolicy` ya da eşdeğer ayrı alan tanımlanır;
   shell politikasıyla karıştırılmaz. Sub-agent'lara parent policy ile aktarılır.
   `Ask`, `Allow`, `Deny` davranışları sırasıyla onay, sessiz çalışma ve
   `Plan mode active — finalize or apply the plan first` hatasıdır.
5. **[crate] Onay.** Mevcut `ask_user` kullanılır. `MessageTool`, opsiyonel
   metadata'yı `OutboundMessage`'a geçirir. Reddetme deny-default parse edilir,
   `edit denied by user` ile sonlanır ve doom-loop sayacından hariç tutulur.
6. **[altai] Uçtan uca event sözleşmesi.** Clarification event'i `metadata`yı
   taşıyacak şekilde genişletilir; bridge ve store bunu `pendingEditDiff` olarak
   saklar. Sohbet içindeki approval kartı preview'i render eder ve mevcut
   approve/deny yanıt yolunu kullanır. Raw metadata loglanmaz.
7. **[altai] Mod eşlemesi.** `ask → Ask`, `auto-edit/bypass → Allow`,
   `plan → Deny`. Shell eşlemesi bağımsız kalır: `auto-edit` shell komutlarını
   otomatik onaylamaz.

### Doğrulama

- Ask modunda create, overwrite ve exact edit preview gösterir; approve doğru
  içeriği yazar, deny hiç yazmaz.
- Onay beklerken dışarıdan değişen dosya yazılmaz ve yenilenmiş preview istenir.
- Büyük/gizli dosya preview'i sınırlandırılır; içerik chat geçmişine sızmaz.
- Auto-edit/bypass sessiz çalışır; plan modu yazmaz.
- Sub-agent mutasyonları da aynı gate'ten geçer.
- Crate unit/integration testleri ve ALTAI event/store/UI testleri eklenir.

---

## ITEM 5 — Deterministik edit retry

**Hedef:** exact `old_text` bulunmadığında gereksiz retry döngüsünü azaltmak;
yanlış dosya değişikliğini asla kolaylaştırmamak.

1. **[crate]** Satır sonu ve whitespace normalize edilmiş arama yalnızca tek
   canonical eşleşme verirse uygulanır. Birden fazla eşleşme varsa otomatik
   mutasyon yapılmaz.
2. **[crate]** `0 matches` veya belirsiz eşleşmede aday satır aralıkları döner;
   model daha fazla bağlamla yeni bir `edit_file` çağrısı yapar.
3. **[crate]** `replace_all` mevcut davranışını korur; testler exact, tek fuzzy,
   çoklu fuzzy ve CRLF senaryolarını kapsar.

---

## ITEM 3 — Granüler auto-approval kuralları

**Hedef:** güvenli ve öngörülebilir kurallarla yaygın işlemlerin onaysız
çalışabilmesi.

1. **[crate]** Kural önceliği: `explicit deny > explicit allow > mode default`.
   Kural sonuçları telemetry'de yalnızca özet olarak görünür.
2. **[crate]** Shell kuralları raw shell string üzerinde globlanmaz. Ayrıştırılmış
   executable + argv sınırlarıyla eşleşir; `npm test; rm -rf ...` gibi zincir
   komutlar allowlist'i geçemez.
3. **[crate]** Edit kuralları canonical workspace-relative path üzerinde globlanır;
   `..`, symlink ve mutlak yol kaçışları normalize edilmeden eşleşmez.
4. **[altai]** `.isanagent/config.toml` ve Permissions UI, rule kind/etki/örnek
   açıklamasını taşır. `read_file` rule'u eklenmez; okuma zaten edit gate'inin
   dışında kalır.

---

## ITEM 6 — Plan mode

**Hedef:** plan oluşturma ile dosya mutasyonunu runtime seviyesinde ayırmak.

1. **[altai + crate]** Plan modu ITEM 1 `Deny` edit politikasını kullanır;
   tool hata mesajı modele neden yazamadığını açıklar.
2. **[altai]** "Apply plan" UI'daki açık kullanıcı eylemidir. Modelin
   `ask_user` istemesi yardımcı olabilir ama tek başına mod değiştiremez.
3. **[altai]** Onay sonrası kullanıcı seçtiği `ask` veya `auto-edit` moda geçer;
   plan/todo'lar izlenebilir görev durumuna dönüştürülür.

---

## ITEM 4 — Checkpoint timeline

**Hedef:** belirli bir turn sonrasındaki tüm agent mutasyonlarını geri almak.

1. **[crate]** Checkpoint meta'ya backward-compatible `turn_id: Option<String>`
   eklenir. Eski kayıtlar `None` olarak okunur.
2. **[crate]** Her agent tool-turn'ü aynı `turn_id` altında snapshot üretir.
3. **[crate + altai]** "Restore to turn T", **T'den sonraki** turn'lerin
   snapshot'larını ters kronolojik sırada uygular; T grubunu restore etmez.
   Bu semantik 2. turn'e dönüşte 3. turn'ü geri alır, 2. turn'ü korur.
4. **[altai]** Önizleme, etkilenecek dosyaları ve restore sırasını gösterir.
   Restore işleminde hata olursa kısmi sonuç açıkça raporlanır; sonraki adımda
   transaction/rollback stratejisi değerlendirilir.
5. **[altai]** Workspace/chat kimliği timeline'a dahil edilir; app-level
   process-global store farklı workspace kayıtlarını karıştırmaz.

---

## ITEM 2 — Mevcut MCP uygulamasını tamamlama

1. **[altai]** Mevcut stdio MCP istemcisini koru; config'i Claude Desktop uyumlu
   `{ "mcpServers": { ... } }` biçiminde oku/yaz. Gerekirse eski dizi biçimini
   bir sürüm boyunca migration ile oku.
2. **[altai]** Tool isimlendirmesini dokümante edilmiş `mcp__<server>__<tool>`
   biçimine geçir veya mevcut tek-altçizgi biçimini açıkça public contract yap;
   geçişte eski isimleri kırma.
3. **[altai]** Server başına `starting/connected/error` runtime durumu ve son
   hata nedeni UI'a sunulur. Başarısız sunucu built-in agent'ı engellemez.
4. **[altai]** Global config ve HTTP/SSE yalnızca gerçek kullanıcı ihtiyacı
   doğrulanırsa eklenir; stdio MVP'nin bir parçası değildir.
5. **[altai]** Gerçek bir stdio fixture ile initialize → initialized → tools/list
   → tools/call ve workspace değişiminde child cleanup test edilir.

---

## ITEM 7 — `.isanagentignore` doğrulaması

Crate rev'inde bulunan ignore desteği için ALTAI entegrasyon testi eklenir:
read/list/search ve mutate çağrıları ignore edilmiş path'i reddetmeli; normal
workspace path'leri çalışmalıdır. Yeni crate özelliği yazılmaz.

---

## Uygulama sırası

1. ITEM 1 edit-policy/preflight/event sözleşmesi.
2. ITEM 5 deterministik retry (ITEM 1 crate çalışmasıyla aynı PR olabilir).
3. ITEM 3 allowlist.
4. ITEM 6 plan mode.
5. ITEM 4 checkpoint timeline.
6. ITEM 2'nin mevcut MCP uygulamasını uyumluluk ve durum görünürlüğü açısından
   tamamlama.
7. ITEM 7 entegrasyon doğrulaması.

## Her PR için doğrulama

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
pnpm test
```

Crate PR'lerinde ilgili unit/integration testleriyle `cargo test` çalıştırılır.
