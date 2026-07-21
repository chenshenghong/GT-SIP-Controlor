import { setActivePinia, createPinia } from 'pinia'
import { useDayuCredentialStore } from '../src/renderer/stores/dayuCredentials'

describe('dayuCredentials store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('未設定過的 IP → 回出廠預設 admin/admin', () => {
    const store = useDayuCredentialStore()
    expect(store.getCredentials('192.168.1.155')).toEqual({ username: 'admin', password: 'admin' })
  })

  it('設定後依 IP 取回；不同 IP 互不影響', () => {
    const store = useDayuCredentialStore()
    store.setCredentials('192.168.1.155', 'admin', 's3cret')
    expect(store.getCredentials('192.168.1.155')).toEqual({ username: 'admin', password: 's3cret' })
    expect(store.getCredentials('192.168.1.156')).toEqual({ username: 'admin', password: 'admin' })
  })

  it('重複設定覆蓋舊值', () => {
    const store = useDayuCredentialStore()
    store.setCredentials('192.168.1.155', 'admin', 'a')
    store.setCredentials('192.168.1.155', 'root', 'b')
    expect(store.getCredentials('192.168.1.155')).toEqual({ username: 'root', password: 'b' })
  })
})
