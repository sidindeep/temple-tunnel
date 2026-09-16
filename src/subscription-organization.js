function organizeSubscriptions(saved, activeId, change) {
  if (Array.isArray(change?.ids)) {
    if (change.ids.length !== saved.length || new Set(change.ids).size !== saved.length
      || change.ids.some(id => !saved.some(item => item.id === id))) throw new Error('Список подписок изменился. Повторите перемещение.');
    return change.ids.map(id => saved.find(item => item.id === id));
  }
  if (typeof change?.hidden !== 'boolean' || !saved.some(item => item.id === change.id)) throw new Error('Подписка не найдена.');
  if (change.hidden && change.id === activeId) throw new Error('Сначала выберите другую подписку, затем скройте эту.');
  return saved.map(item => item.id === change.id ? {...item,hidden:change.hidden} : item);
}
module.exports={organizeSubscriptions};
