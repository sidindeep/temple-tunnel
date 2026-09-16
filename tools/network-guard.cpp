#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fwpmu.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <string>
#include <vector>
#include <iostream>
#include <stdexcept>
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "rpcrt4.lib")
// Persistent filters survive both UI and VPN-core crashes. All replacements are
// transactional; a failed replacement leaves the previous protection intact.
static GUID group = {0x486be95e,0x42f2,0x40df,{0x93,0x11,0x21,0xbd,0x49,0xb8,0x58,0x6a}};
static HANDLE engine = nullptr;
static void check(DWORD code, const char* operation = "operation") { if (code) throw std::runtime_error(std::string(operation) + ": " + std::to_string(code)); }
static std::vector<UINT64> ownedFilters(const GUID& layer) {
  HANDLE enumeration = nullptr;
  FWPM_FILTER_ENUM_TEMPLATE0 query = {}; query.providerKey = &group; query.layerKey = layer; query.actionMask = 0xffffffff;
  check(FwpmFilterCreateEnumHandle0(engine, &query, &enumeration), "enumeration-open");
  std::vector<UINT64> ids;
  try {
    for (;;) {
      FWPM_FILTER0** entries = nullptr; UINT32 count = 0;
      check(FwpmFilterEnum0(engine, enumeration, 128, &entries, &count), "enumeration-read");
      for (UINT32 i = 0; i < count; i++) {
        if (entries[i]->providerKey && *entries[i]->providerKey == group && entries[i]->subLayerKey == group)
          ids.push_back(entries[i]->filterId);
      }
      FwpmFreeMemory0(reinterpret_cast<void**>(&entries));
      if (!count) break;
    }
  } catch (...) { FwpmFilterDestroyEnumHandle0(engine, enumeration); throw; }
  FwpmFilterDestroyEnumHandle0(engine, enumeration);
  return ids;
}
static void clearFilters() {
  for (auto layer : {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6})
    for (auto id : ownedFilters(layer)) check(FwpmFilterDeleteById0(engine, id), "filter-delete");
}
static void filter(const GUID& layer, bool permit, UINT64 priority, std::vector<FWPM_FILTER_CONDITION0> conditions) {
  FWPM_FILTER0 f = {}; UuidCreate(&f.filterKey);
  f.displayData.name = const_cast<wchar_t*>(L"Temple Tunnel network protection");
  f.providerKey = &group; f.subLayerKey = group; f.layerKey = layer;
  f.flags = FWPM_FILTER_FLAG_PERSISTENT;
  f.action.type = permit ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
  f.weight.type = FWP_UINT64; f.weight.uint64 = &priority;
  f.numFilterConditions = static_cast<UINT32>(conditions.size()); f.filterCondition = conditions.data();
  check(FwpmFilterAdd0(engine, &f, nullptr, nullptr));
}
static FWPM_FILTER_CONDITION0 number(const GUID& field, FWP_DATA_TYPE type, UINT32 value) {
  FWPM_FILTER_CONDITION0 c = {}; c.fieldKey = field; c.matchType = FWP_MATCH_EQUAL;
  c.conditionValue.type = type; c.conditionValue.uint32 = value; return c;
}
static void application(const GUID& layer, const std::wstring& file, bool permit) {
  FWP_BYTE_BLOB* id = nullptr; check(FwpmGetAppIdFromFileName0(file.c_str(), &id));
  FWPM_FILTER_CONDITION0 c = {}; c.fieldKey = FWPM_CONDITION_ALE_APP_ID;
  c.matchType = FWP_MATCH_EQUAL; c.conditionValue.type = FWP_BYTE_BLOB_TYPE; c.conditionValue.byteBlob = id;
  try { filter(layer, permit, permit ? 900 : 100, {c}); }
  catch (...) { FwpmFreeMemory0(reinterpret_cast<void**>(&id)); throw; }
  FwpmFreeMemory0(reinterpret_cast<void**>(&id));
}
int wmain(int argc, wchar_t** argv) {
  bool transaction = false;
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--version") { std::cout << "TempleGuard 2\n"; return 0; }
    if (argc < 2) return 64;
    std::wstring action = argv[1];
    if (action != L"clear" && action != L"apply" && action != L"validate" && action != L"status") return 64;
    std::wstring mode, tun;
    std::vector<std::wstring> allow, protect;
    if (action == L"apply" || action == L"validate") {
      if (argc < 4) return 64; mode = argv[2]; tun = argv[3];
      if (mode != L"full" && mode != L"selected" && mode != L"bypass") return 64;
      for (int i = 4; i < argc; i += 2) {
        if (i + 1 >= argc) return 64;
        if (std::wstring(argv[i]) == L"--allow") allow.push_back(argv[i+1]);
        else if (std::wstring(argv[i]) == L"--protect") protect.push_back(argv[i+1]);
        else return 64;
      }
      if (mode == L"selected" && protect.empty()) return 64;
    }
    check(FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, nullptr, &engine), "engine-open");
    if (action == L"status") {
      bool active = !ownedFilters(FWPM_LAYER_ALE_AUTH_CONNECT_V4).empty();
      active = !ownedFilters(FWPM_LAYER_ALE_AUTH_CONNECT_V6).empty() || active;
      std::cout << (active ? "active" : "off") << "\n";
      FwpmEngineClose0(engine); return 0;
    }
    check(FwpmTransactionBegin0(engine, 0)); transaction = true;
    FWPM_PROVIDER0 p = {}; p.providerKey = group; p.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
    p.displayData.name = const_cast<wchar_t*>(L"Temple Tunnel");
    DWORD result = FwpmProviderAdd0(engine,&p,nullptr); if (result != FWP_E_ALREADY_EXISTS) check(result);
    FWPM_SUBLAYER0 s = {}; s.subLayerKey = group; s.providerKey = &group;
    s.flags = FWPM_SUBLAYER_FLAG_PERSISTENT; s.weight = 0xfffe;
    s.displayData.name = const_cast<wchar_t*>(L"Temple Tunnel protection");
    result = FwpmSubLayerAdd0(engine,&s,nullptr); if (result != FWP_E_ALREADY_EXISTS) check(result);
    clearFilters();
    if (action == L"apply" || action == L"validate") {
      NET_LUID luid = {}; if (tun != L"-") check(ConvertInterfaceAliasToLuid(tun.c_str(), &luid));
      for (auto layer : {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6}) {
        auto loop = number(FWPM_CONDITION_FLAGS, FWP_UINT32, FWP_CONDITION_FLAG_IS_LOOPBACK);
        loop.matchType = FWP_MATCH_FLAGS_ALL_SET; filter(layer,true,1000,{loop});
        for (auto& file : allow) application(layer,file,true);
        if (luid.Value) {
          FWPM_FILTER_CONDITION0 c = {}; c.fieldKey = FWPM_CONDITION_IP_LOCAL_INTERFACE; c.matchType = FWP_MATCH_EQUAL;
          c.conditionValue.type = FWP_UINT64; c.conditionValue.uint64 = &luid.Value; filter(layer,true,800,{c});
        }
        // DHCP is required to restore a lost network; it carries no application DNS.
        auto protocol = number(FWPM_CONDITION_IP_PROTOCOL,FWP_UINT8,17);
        auto local = number(FWPM_CONDITION_IP_LOCAL_PORT,FWP_UINT16,layer == FWPM_LAYER_ALE_AUTH_CONNECT_V4 ? 68 : 546);
        auto remote = number(FWPM_CONDITION_IP_REMOTE_PORT,FWP_UINT16,layer == FWPM_LAYER_ALE_AUTH_CONNECT_V4 ? 67 : 547);
        filter(layer,true,700,{protocol,local,remote});
        // Windows DNS Client is shared by all apps: do not let it send protected
        // lookups outside the tunnel. Core-originated direct DNS is allowed above.
        filter(layer,false,300,{number(FWPM_CONDITION_IP_REMOTE_PORT,FWP_UINT16,53)});
        if (mode == L"selected") for (auto& file : protect) application(layer,file,false);
        else filter(layer,false,100,{});
      }
    }
    if (action == L"validate") check(FwpmTransactionAbort0(engine));
    else check(FwpmTransactionCommit0(engine));
    transaction = false;
    FwpmEngineClose0(engine); std::cout << "ok\n"; return 0;
  } catch (const std::exception& e) {
    if (transaction) FwpmTransactionAbort0(engine);
    if (engine) FwpmEngineClose0(engine);
    std::cerr << "WFP error " << e.what() << "\n"; return 1;
  }
}
