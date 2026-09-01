// ============================================
// 泉州鑫廚房 → 華安央廚 轉移完整度檢查（唯讀，不會寫入）
// 使用方式：登入系統任一頁面 → F12 開 Console → 貼上執行
// ============================================
(async () => {
  const OLD = '泉州鑫廚房';
  const NEW = '華安央廚';
  const { getFirestore, doc, getDoc, collection, getDocs } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  const db = getFirestore();
  const report = {};

  // ① hr/settings.workLocations
  {
    const snap = await getDoc(doc(db, 'hr', 'settings'));
    const arr = snap.data().workLocations || [];
    report['① workLocations 含泉州鑫廚房'] = arr.includes(OLD);
    report['① workLocations 含華安央廚'] = arr.includes(NEW);
  }

  // ② hr/employees.list（在職同仁）
  {
    const snap = await getDoc(doc(db, 'hr', 'employees'));
    const list = snap.data().list || [];
    const stillOld = list.filter(e => e.location === OLD);
    const nowNew = list.filter(e => e.location === NEW);
    report['② 仍在泉州鑫廚房的在職同仁'] = stillOld.map(e => e.name);
    report['② 已在華安央廚的在職同仁'] = nowNew.map(e => e.name);
  }

  // ③ hr/interviews.list（應徵者）
  {
    const snap = await getDoc(doc(db, 'hr', 'interviews'));
    const list = snap.data().list || [];
    const stillOld = list.filter(e => e.location === OLD);
    report['③ 仍指向泉州鑫廚房的應徵者'] = stillOld.map(e => e.name);
  }

  // ④ users（帳號 locations 陣列）
  {
    const snap = await getDocs(collection(db, 'users'));
    const stillOld = [];
    snap.forEach(d => {
      const locs = d.data().locations || [];
      if (locs.includes(OLD)) stillOld.push(`${d.data().name}(${locs.join(',')})`);
    });
    report['④ users 仍含泉州鑫廚房的帳號'] = stillOld;
  }

  // ⑤ store_accounts
  {
    const snap = await getDocs(collection(db, 'store_accounts'));
    const stillOld = [];
    snap.forEach(d => { if (d.data().location === OLD) stillOld.push(d.id); });
    report['⑤ store_accounts 仍為泉州鑫廚房'] = stillOld;
  }

  // ⑥ shift_types（班別設定文件是否存在）
  {
    const oldSnap = await getDoc(doc(db, 'shift_types', OLD));
    const newSnap = await getDoc(doc(db, 'shift_types', NEW));
    report['⑥ shift_types/泉州鑫廚房 存在'] = oldSnap.exists();
    report['⑥ shift_types/華安央廚 存在'] = newSnap.exists();
  }

  console.log('=== 轉移完整度檢查 ===');
  console.table(report);
  console.log('若「④／⑤ 仍含泉州鑫廚房」或「⑥ 華安央廚不存在」有內容，代表這幾處還沒轉，請截圖給開發者。');
})();
