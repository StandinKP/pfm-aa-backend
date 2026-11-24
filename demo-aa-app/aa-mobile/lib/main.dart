// Demo Account Aggregator app — replicates the screen flow observed in
// Saafe's sandbox app (login/OTP, local passcode, home tabs, account-type
// select, FIP discovery, identifiers, bank OTP, account selection) against
// aa-backend, plus a consent-approval screen for the step an FIU would
// trigger in the real protocol.
//
// Deliberately has no SIM-binding check — that's the real app's device-
// identity step, which an emulator/demo build can never satisfy anyway.
// Synthetic data only.
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

// 10.0.2.2 is the Android emulator's alias for the host machine's localhost.
const apiBase = 'http://10.0.2.2:8788';

void main() => runApp(const AaDemoApp());

class AaDemoApp extends StatelessWidget {
  const AaDemoApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo AA',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0F6F6A),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF5F7F8),
      ),
      home: const RootScreen(),
    );
  }
}

class Account {
  final String accountRef, fipId, maskedNumber, type;
  Account({required this.accountRef, required this.fipId, required this.maskedNumber, required this.type});
  factory Account.fromJson(Map<String, dynamic> j) => Account(
      accountRef: j['accountRef'], fipId: j['fipId'], maskedNumber: j['maskedNumber'], type: j['type']);
}

class Fip {
  final String id, name;
  Fip(this.id, this.name);
}

class ConsentDetail {
  final String consentHandle, fiuId, purpose, dateRangeFrom, dateRangeTo, status;
  final String? consentId;
  final List<String> fiTypes;
  ConsentDetail.fromJson(Map<String, dynamic> j)
      : consentHandle = j['consentHandle'],
        fiuId = j['fiuId'],
        purpose = j['purpose'],
        dateRangeFrom = j['dateRangeFrom'],
        dateRangeTo = j['dateRangeTo'],
        status = j['status'],
        consentId = j['consentId'],
        fiTypes = List<String>.from(j['fiTypes']);
}

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => message;
}

class Api {
  String? token;

  Future<dynamic> _send(String method, String path, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('$apiBase$path');
    final headers = {
      'content-type': 'application/json',
      if (token != null) 'authorization': 'Bearer $token',
    };
    late http.Response res;
    switch (method) {
      case 'GET':
        res = await http.get(uri, headers: headers);
        break;
      case 'POST':
        res = await http.post(uri, headers: headers, body: body == null ? null : jsonEncode(body));
        break;
    }
    final decoded = res.body.isEmpty ? {} : jsonDecode(res.body);
    if (res.statusCode >= 400) {
      throw ApiException(decoded['error'] ?? 'request failed (${res.statusCode})');
    }
    return decoded;
  }

  Future<Map> get(String path) => _send('GET', path).then((d) => d as Map);
  Future<Map> post(String path, [Map<String, dynamic>? body]) => _send('POST', path, body: body).then((d) => d as Map);
}

// ---- Screen stack ----

sealed class Screen {}
class SplashScreen extends Screen {}
class MobileScreen extends Screen {}
class OtpScreen extends Screen { final String requestId, mobile; OtpScreen(this.requestId, this.mobile); }
class PasscodeScreen extends Screen {}
class HomeScreen extends Screen {
  final int tab; // 0 home, 1 consents, 2 accounts, 3 more
  final HomeSub? sub;
  HomeScreen({this.tab = 0, this.sub});
}

sealed class HomeSub {}
class AccountTypeSub extends HomeSub {}
class FipSelectSub extends HomeSub {}
class SettingsSub extends HomeSub {}
class SmartToolsSub extends HomeSub {}
class HistorySub extends HomeSub {}
class FaqSub extends HomeSub {}
class DetailSub extends HomeSub { final String title; final String body; final HomeSub? returnTo; DetailSub(this.title, this.body, {this.returnTo}); }
class IdentifiersSub extends HomeSub { final String fipId; IdentifiersSub(this.fipId); }
class BankOtpSub extends HomeSub { final String linkRefNumber; BankOtpSub(this.linkRefNumber); }
class AccountSelectSub extends HomeSub { final String linkRefNumber; final List<Account> accounts; AccountSelectSub(this.linkRefNumber, this.accounts); }
class LinkSuccessSub extends HomeSub { final List<Account> linked; LinkSuccessSub(this.linked); }
class ConsentDetailSub extends HomeSub { final ConsentDetail consent; ConsentDetailSub(this.consent); }

class RootScreen extends StatefulWidget {
  const RootScreen({super.key});
  @override
  State<RootScreen> createState() => _RootScreenState();
}

class _RootScreenState extends State<RootScreen> {
  final api = Api();
  Screen screen = SplashScreen();
  String mobile = '';
  List<Account> linkedAccounts = [];
  List<Fip> fips = [];
  final Map<String, String> linkRefByFip = {};
  String? error;
  bool busy = false;
  bool showAmount = true;
  String theme = "System";
  String passcode = "";

  void setScreen(Screen s) => setState(() { error = null; screen = s; });

  Future<void> guarded(Future<void> Function() fn) async {
    setState(() { busy = true; error = null; });
    try {
      await fn();
    } catch (e) {
      setState(() => error = e is ApiException ? e.message : e.toString());
    } finally {
      setState(() => busy = false);
    }
  }

  Future<void> refreshAccounts() async {
    final body = await api.get('/v1/accounts');
    linkedAccounts = (body['accounts'] as List).map((a) => Account.fromJson(a)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final s = screen;
    return Scaffold(
      body: SafeArea(
        child: switch (s) {
          SplashScreen() => _splash(),
          MobileScreen() => _mobile(),
          OtpScreen() => _otp(s),
          PasscodeScreen() => _passcode(),
          HomeScreen() => _home(s),
        },
      ),
    );
  }

  Widget _screenBody({Widget? leading, required String title, String? subtitle, required List<Widget> children}) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (leading != null) leading,
        if (leading != null) const SizedBox(height: 12),
        Text(title, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
        if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(subtitle, style: TextStyle(color: Colors.grey.shade700))),
        const SizedBox(height: 16),
        if (error != null) Container(
          margin: const EdgeInsets.only(bottom: 12),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: const Color(0xFFFDE8E6), borderRadius: BorderRadius.circular(10)),
          child: Text(error!, style: const TextStyle(color: Color(0xFFB3261E))),
        ),
        ...children,
      ]),
    );
  }

  Widget _backButton(VoidCallback onTap) => IconButton.filledTonal(onPressed: onTap, icon: const Icon(Icons.chevron_left));

  Widget _primaryButton(String label, VoidCallback? onTap) => SizedBox(
        width: double.infinity,
        child: FilledButton(onPressed: busy ? null : onTap, child: Padding(padding: const EdgeInsets.all(14), child: Text(label))),
      );

  Widget _otpBoxes(int count, void Function(String) onComplete) {
    final controllers = List.generate(count, (_) => TextEditingController());
    final focusNodes = List.generate(count, (_) => FocusNode());
    return _OtpRow(controllers: controllers, focusNodes: focusNodes, onComplete: onComplete);
  }

  Widget _splash() => _screenBody(
        title: 'Link your financial accounts with Demo AA',
        subtitle: 'Synthetic data only — a demo replica of the Saafe sandbox flow. Not SIM-bound: any device can use it.',
        children: [_primaryButton('Get started', () => setScreen(MobileScreen()))],
      );

  Widget _mobile() {
    final controller = TextEditingController(text: mobile);
    return _screenBody(
      leading: _backButton(() => setScreen(SplashScreen())),
      title: 'Log in to Demo AA Sandbox',
      subtitle: 'Enter your mobile number to log in',
      children: [
        TextField(controller: controller, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile number', border: OutlineInputBorder())),
        const SizedBox(height: 16),
        _primaryButton('Continue', () => guarded(() async {
              final m = controller.text.trim();
              if (!RegExp(r'^\d{10}$').hasMatch(m)) { setState(() => error = 'Enter a 10-digit mobile number'); return; }
              mobile = m;
              final body = await api.post('/v1/auth/otp/request', {'mobile': m});
              setScreen(OtpScreen(body['requestId'], m));
            })),
      ],
    );
  }

  Widget _otp(OtpScreen s) {
    return _screenBody(
      leading: _backButton(() => setScreen(MobileScreen())),
      title: '4 digit code',
      subtitle: "Please enter the code we've sent to *******${s.mobile.substring(s.mobile.length - 3)}\n(demo OTP is logged in the backend console, never SMS'd)",
      children: [
        _otpBoxes(4, (otp) => guarded(() async {
              final body = await api.post('/v1/auth/otp/verify', {'requestId': s.requestId, 'otp': otp});
              api.token = body['token'];
              setScreen(PasscodeScreen());
            })),
      ],
    );
  }

  Widget _passcode() {
    return _screenBody(
      title: 'Enter Passcode',
      subtitle: 'Set a local passcode for this device (demo: not checked on re-entry)',
      children: [
        _otpBoxes(4, (pin) => guarded(() async {
              passcode = pin;
              await refreshAccounts();
              setScreen(HomeScreen(tab: 0));
            })),
      ],
    );
  }

  Widget _home(HomeScreen s) {
    final body = s.sub != null ? _homeSub(s, s.sub!) : switch (s.tab) {
      0 => _homeTab(),
      1 => _consentsTab(s),
      2 => _accountsTab(s),
      _ => _moreTab(s),
    };
    return Column(
      children: [
        Expanded(child: body),
        if (s.sub == null) NavigationBar(
          selectedIndex: s.tab,
          onDestinationSelected: (i) => setScreen(HomeScreen(tab: i)),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.pie_chart_outline), label: 'Home'),
            NavigationDestination(icon: Icon(Icons.description_outlined), label: 'Consents'),
            NavigationDestination(icon: Icon(Icons.account_balance_outlined), label: 'Accounts'),
            NavigationDestination(icon: Icon(Icons.grid_view), label: 'More'),
          ],
        ),
      ],
    );
  }

  static const _homeCategories = [
    ['Transfer', 20000.0, Color(0xFF0F6F6A)],
    ['Shopping', 6800.0, Color(0xFF2BB3A8)],
    ['Food', 4200.0, Color(0xFF55C2B6)],
    ['Utilities', 2100.0, Color(0xFF8AD4C8)],
    ['Entertainment', 1500.0, Color(0xFFB8E5DC)],
  ];
  static const _homeIncome = 85000.0;

  String _formatInr(int n) {
    final s = n.toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 == 0) buf.write(',');
      buf.write(s[i]);
    }
    return buf.toString();
  }

  String _money(num n) => showAmount ? '₹${_formatInr(n.toInt())}' : '••••••';

  Widget _statTile(String label, String value) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade300), borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
          const SizedBox(height: 4),
          Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        ]),
      );

  Widget _nudge(String text) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.08),
          border: Border(left: BorderSide(color: Theme.of(context).colorScheme.primary, width: 3)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(text, style: const TextStyle(fontSize: 13.5)),
      );

  Widget _homeTab() {
    final subtitle = 'Mobile ending ${mobile.isNotEmpty ? mobile.substring(mobile.length - 4) : "----"}';

    if (linkedAccounts.isEmpty) {
      return _screenBody(
        title: 'Hello!',
        subtitle: subtitle,
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
                Text('Get your personalised dashboard!', style: TextStyle(fontWeight: FontWeight.bold)),
                SizedBox(height: 4),
                Text('Link your account & take control of your finances'),
              ]),
            ),
          ),
        ],
      );
    }

    final totalBalance = linkedAccounts.fold<int>(0, (sum, a) => sum + (a.type == 'Savings' ? 91360 : 42150));
    final totalSpend = _homeCategories.fold<double>(0, (a, c) => a + (c[1] as double));
    final maxCat = _homeCategories.map((c) => c[1] as double).reduce((a, b) => a > b ? a : b);

    return _screenBody(
      title: 'Hello!',
      subtitle: subtitle,
      children: [
        Card(
          color: Theme.of(context).colorScheme.primary,
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Total balance', style: TextStyle(color: Colors.white70)),
              const SizedBox(height: 6),
              Text(_money(totalBalance), style: const TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              Text('across ${linkedAccounts.length} linked account${linkedAccounts.length == 1 ? "" : "s"}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(child: _statTile('Spend', _money(totalSpend))),
          const SizedBox(width: 10),
          Expanded(child: _statTile('Income', _money(_homeIncome))),
        ]),
        const SizedBox(height: 16),
        const Text('For you today', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        const SizedBox(height: 8),
        _nudge('Your spending on Transfer is up this month — review before next cycle.'),
        _nudge("You're on track with your savings goal this month."),
        const SizedBox(height: 20),
        const Text('Spending by category', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
        const SizedBox(height: 8),
        for (final c in _homeCategories)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                Text(c[0] as String),
                Text(_money(c[1] as double), style: TextStyle(color: Colors.grey.shade700)),
              ]),
              const SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: (c[1] as double) / maxCat,
                  minHeight: 6,
                  backgroundColor: Colors.grey.shade200,
                  valueColor: AlwaysStoppedAnimation(c[2] as Color),
                ),
              ),
            ]),
          ),
        const SizedBox(height: 8),
        Text("Synthetic demo numbers — not computed from your linked accounts' real data.", style: TextStyle(color: Colors.grey.shade500, fontSize: 11)),
      ],
    );
  }

  Widget _accountsTab(HomeScreen s) {
    if (linkedAccounts.isEmpty) {
      return _screenBody(title: "You don't have accounts", subtitle: 'Start linking your accounts right away', children: [
        _primaryButton('Get Started', () => setScreen(HomeScreen(tab: s.tab, sub: AccountTypeSub()))),
      ]);
    }
    return _screenBody(title: 'Your accounts', children: [
      for (final a in linkedAccounts)
        Card(margin: const EdgeInsets.only(bottom: 8), child: ListTile(title: Text(a.fipId), subtitle: Text('${a.type} · ${a.maskedNumber}'))),
      const SizedBox(height: 8),
      OutlinedButton(onPressed: () => setScreen(HomeScreen(tab: s.tab, sub: AccountTypeSub())), child: const Text('+ Link another account')),
    ]);
  }

  Widget _consentsTab(HomeScreen s) {
    final controller = TextEditingController();
    return _screenBody(title: 'Consents', subtitle: "In the real app, an FIU's consent request opens this screen directly (deep link). This demo has no deep-linking set up — paste a consent handle an FIU backend gave you.", children: [
      TextField(controller: controller, decoration: const InputDecoration(labelText: 'Consent handle', border: OutlineInputBorder())),
      const SizedBox(height: 16),
      _primaryButton('Look up', () => guarded(() async {
            final handle = controller.text.trim();
            if (handle.isEmpty) return;
            final body = await api.get('/v1/consent/$handle');
            setScreen(HomeScreen(tab: s.tab, sub: ConsentDetailSub(ConsentDetail.fromJson(body as Map<String, dynamic>))));
          })),
    ]);
  }

  Widget _moreTab(HomeScreen s) {
    void open(HomeSub sub) => setScreen(HomeScreen(tab: s.tab, sub: sub));
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          CircleAvatar(radius: 28, child: Text(mobile.length >= 2 ? mobile.substring(0, 2) : '??')),
          const SizedBox(width: 12),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Demo customer', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            Text(mobile.isEmpty ? '—' : mobile, style: TextStyle(color: Colors.grey.shade700)),
          ]),
        ]),
        const SizedBox(height: 20),
        _menuRow(Icons.settings_outlined, 'Settings', null, () => open(SettingsSub())),
        _menuRow(Icons.build_outlined, 'Smart tools', 'Plan, track, and optimize your finances', () => open(SmartToolsSub())),
        _menuRow(Icons.inventory_2_outlined, 'History', 'Review your latest activity', () => open(HistorySub())),
        _menuRow(Icons.help_outline, 'Help center', 'Flag issues and get them solved', () => open(DetailSub('Help Center', 'Not wired up in this demo.'))),
        _menuRow(Icons.article_outlined, 'Frequently asked', 'Find answers instantly', () => open(FaqSub())),
        _menuRow(Icons.info_outline, 'Terms & Conditions', null, () => open(DetailSub('Terms & Conditions', 'Demo app — synthetic data only. No real terms apply here.'))),
        _menuRow(Icons.shield_outlined, 'About Demo AA', null, () => open(DetailSub('About Demo AA',
            'Demo AA is a non-commercial demo built to learn and test the Account Aggregator consent flow end to end. '
            'It is not affiliated with, endorsed by, or a substitute for any real Account Aggregator. Every number, '
            'account and identifier here is synthetic.'))),
        _menuRow(Icons.logout, 'Logout & Clear Data', null, () {
          api.token = null;
          linkedAccounts = [];
          mobile = '';
          passcode = '';
          setScreen(SplashScreen());
        }),
      ]),
    );
  }

  Widget _sectionLabel(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 18, 2, 8),
        child: Text(text, style: TextStyle(color: Colors.grey.shade600, fontWeight: FontWeight.w600)),
      );

  Widget _menuRow(IconData icon, String title, String? subtitle, VoidCallback onTap, {Widget? trailing}) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(children: [
            Icon(icon, color: Theme.of(context).colorScheme.primary),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                if (subtitle != null) Text(subtitle, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
              ]),
            ),
            trailing ?? Icon(Icons.chevron_right, color: Colors.grey.shade400),
          ]),
        ),
      );

  Widget _homeSub(HomeScreen s, HomeSub sub) {
    void back(HomeSub? to) => setScreen(HomeScreen(tab: s.tab, sub: to));

    if (sub is AccountTypeSub) {
      return _screenBody(
        leading: _backButton(() => back(null)),
        title: 'Select account type to link',
        children: [
          _primaryButton('Bank — Current, Savings', () => guarded(() async {
                final body = await api.get('/v1/discovery');
                fips = (body['fips'] as List).map((f) => Fip(f['id'], f['name'])).toList();
                setScreen(HomeScreen(tab: s.tab, sub: FipSelectSub()));
              })),
          const SizedBox(height: 8),
          Text('(Pension/Insurance/GST/Investment aren\'t wired up in this demo)', style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
        ],
      );
    }

    if (sub is FipSelectSub) {
      String? picked;
      return StatefulBuilder(builder: (context, setLocal) {
        return _screenBody(
          leading: _backButton(() => back(AccountTypeSub())),
          title: 'Select all banks linked to your number',
          children: [
            for (final f in fips)
              _pickRow(f.name, picked == f.id, () => setLocal(() => picked = f.id)),
            const SizedBox(height: 16),
            _primaryButton('Continue', picked == null ? null : () => guarded(() async {
                  final body = await api.post('/v1/link/start', {'fipId': picked});
                  linkRefByFip[picked!] = body['linkRefNumber'];
                  setScreen(HomeScreen(tab: s.tab, sub: IdentifiersSub(picked!)));
                })),
          ],
        );
      });
    }

    if (sub is IdentifiersSub) {
      final dobController = TextEditingController();
      return _screenBody(
        leading: _backButton(() => back(FipSelectSub())),
        title: 'Identifiers',
        subtitle: 'Enter PAN or date of birth as registered with your bank. (Demo: no SIM-binding check, no real KYC match — any value works.)',
        children: [
          TextField(controller: dobController, decoration: const InputDecoration(labelText: 'Date of birth (DD/MM/YYYY)', border: OutlineInputBorder())),
          const SizedBox(height: 16),
          _primaryButton('Continue', () => guarded(() async {
                final linkRefNumber = linkRefByFip[sub.fipId]!;
                await api.post('/v1/link/identifiers', {'linkRefNumber': linkRefNumber, 'dob': dobController.text});
                setScreen(HomeScreen(tab: s.tab, sub: BankOtpSub(linkRefNumber)));
              })),
        ],
      );
    }

    if (sub is BankOtpSub) {
      return _screenBody(
        leading: _backButton(() => back(FipSelectSub())),
        title: "Bank verification code",
        subtitle: "Your bank's OTP — in the real app this is sent by the FIP, not Saafe. This demo logs it to the backend console.",
        children: [
          _otpBoxes(4, (otp) => guarded(() async {
                final body = await api.post('/v1/link/accounts', {'linkRefNumber': sub.linkRefNumber, 'otp': otp});
                final accounts = (body['accounts'] as List).map((a) => Account.fromJson(a)).toList();
                setScreen(HomeScreen(tab: s.tab, sub: AccountSelectSub(sub.linkRefNumber, accounts)));
              })),
        ],
      );
    }

    if (sub is AccountSelectSub) {
      final picked = <String>{};
      return StatefulBuilder(builder: (context, setLocal) {
        return _screenBody(
          leading: _backButton(() => back(null)),
          title: 'Select accounts to link',
          children: [
            for (final a in sub.accounts)
              _pickRow('${a.type} · ${a.maskedNumber}', picked.contains(a.accountRef), () => setLocal(() {
                    if (!picked.add(a.accountRef)) picked.remove(a.accountRef);
                  })),
            const SizedBox(height: 16),
            _primaryButton('Link selected accounts', picked.isEmpty ? null : () => guarded(() async {
                  final body = await api.post('/v1/link/confirm', {'linkRefNumber': sub.linkRefNumber, 'accountRefs': picked.toList()});
                  final linked = (body['linked'] as List).map((a) => Account.fromJson(a)).toList();
                  await refreshAccounts();
                  setScreen(HomeScreen(tab: s.tab, sub: LinkSuccessSub(linked)));
                })),
          ],
        );
      });
    }

    if (sub is LinkSuccessSub) {
      return _screenBody(title: 'Accounts linked', children: [
        for (final a in sub.linked)
          Card(margin: const EdgeInsets.only(bottom: 8), child: ListTile(title: Text('${a.type} · ${a.maskedNumber}'))),
        const SizedBox(height: 16),
        _primaryButton('Done', () => setScreen(HomeScreen(tab: 2))),
      ]);
    }

    if (sub is ConsentDetailSub) {
      final c = sub.consent;
      if (c.status != 'PENDING') {
        if (c.status == 'ACTIVE' && c.consentId != null) {
          return _screenBody(
            leading: _backButton(() => back(null)),
            title: 'Consent — Active',
            children: [_InsightsPanel(api: api, consentId: c.consentId!)],
          );
        }
        return _screenBody(leading: _backButton(() => back(null)), title: 'Consent', children: [Text('Status: ${c.status}')]);
      }
      final picked = <String>{};
      return StatefulBuilder(builder: (context, setLocal) {
        return _screenBody(
          leading: _backButton(() => back(null)),
          title: 'Consent request',
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text.rich(TextSpan(children: [TextSpan(text: c.fiuId, style: const TextStyle(fontWeight: FontWeight.bold)), TextSpan(text: ' wants: ${c.purpose}')])),
                  const SizedBox(height: 4),
                  Text('Data types: ${c.fiTypes.join(", ")} · ${c.dateRangeFrom} → ${c.dateRangeTo}', style: TextStyle(color: Colors.grey.shade700, fontSize: 13)),
                ]),
              ),
            ),
            const SizedBox(height: 16),
            const Text('Choose accounts to share', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            for (final a in linkedAccounts)
              _pickRow('${a.type} · ${a.maskedNumber}', picked.contains(a.accountRef), () => setLocal(() {
                    if (!picked.add(a.accountRef)) picked.remove(a.accountRef);
                  })),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: _primaryButton('Approve', picked.isEmpty ? null : () => guarded(() async {
                    await api.post('/v1/consent/${c.consentHandle}/approve', {'accountRefs': picked.toList()});
                    setScreen(HomeScreen(tab: 1));
                  }))),
              const SizedBox(width: 10),
              Expanded(child: OutlinedButton(onPressed: () => guarded(() async {
                    await api.post('/v1/consent/${c.consentHandle}/deny');
                    setScreen(HomeScreen(tab: 1));
                  }), child: const Padding(padding: EdgeInsets.all(14), child: Text('Deny')))),
            ]),
          ],
        );
      });
    }

    if (sub is SettingsSub) {
      void openDetail(String t, String b) => setScreen(HomeScreen(tab: s.tab, sub: DetailSub(t, b, returnTo: SettingsSub())));
      return _screenBody(
        leading: _backButton(() => back(null)),
        title: 'Settings',
        children: [
          _sectionLabel('Personal information'),
          _menuRow(Icons.person_outline, 'Profile info', 'Edit your info', () => openDetail('Profile info', 'Demo account — nothing to edit, no real KYC on file.')),
          _menuRow(Icons.smartphone_outlined, 'Identifiers', 'Edit or add identifiers', () => openDetail('Identifiers', 'PAN/DOB entered during linking aren\'t stored or validated in this demo.')),
          _sectionLabel('Appearance'),
          _menuRow(Icons.accessibility_new, 'Accessibility', null, () => openDetail('Accessibility', 'Not wired up in this demo.')),
          _menuRow(Icons.wb_sunny_outlined, 'Theme', null, () {
            setState(() => theme = theme == 'System' ? 'Light' : theme == 'Light' ? 'Dark' : 'System');
          }, trailing: Text(theme, style: TextStyle(color: Colors.grey.shade600))),
          _menuRow(Icons.language, 'Language', null, () {}, trailing: Text('English', style: TextStyle(color: Colors.grey.shade600))),
          _sectionLabel('Notifications'),
          _menuRow(Icons.notifications_none, 'Notification preferences', 'Manage summaries and real-time alerts', () => openDetail('Notification preferences', 'Not wired up in this demo.')),
          _sectionLabel('Security'),
          _menuRow(Icons.shield_outlined, 'Show amount', null, () {},
              trailing: Switch(value: showAmount, onChanged: (v) => setState(() => showAmount = v))),
          _menuRow(Icons.lock_outline, 'Change passcode', null, () async {
            final controller = TextEditingController();
            final result = await showDialog<String>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('Change passcode'),
                content: TextField(controller: controller, keyboardType: TextInputType.number, maxLength: 4, decoration: const InputDecoration(labelText: 'New 4-digit passcode')),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
                  FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Save')),
                ],
              ),
            );
            if (result != null && result.length == 4) setState(() => passcode = result);
          }),
          _menuRow(Icons.smartphone, 'Devices', 'Manage logged in devices', () => openDetail('Devices', 'This device — the only one in this demo.')),
          _menuRow(Icons.privacy_tip_outlined, 'Privacy policy', null, () => openDetail('Privacy policy', 'Demo app — synthetic data only. Nothing real is collected.')),
          const SizedBox(height: 8),
          _menuRow(Icons.delete_outline, 'Delete account', null, () {
            api.token = null;
            linkedAccounts = [];
            mobile = '';
            passcode = '';
            setScreen(SplashScreen());
          }),
          const SizedBox(height: 20),
          Center(child: Text('App version: demo-1.0.0', style: TextStyle(color: Colors.grey.shade500, fontSize: 12))),
        ],
      );
    }

    if (sub is SmartToolsSub) {
      return _screenBody(
        leading: _backButton(() => back(null)),
        title: 'Smart Tools',
        children: [
          _menuRow(Icons.track_changes_outlined, 'Retirement Planner', 'Plan your retirement goal',
              () => setScreen(HomeScreen(tab: s.tab, sub: DetailSub('Retirement Planner', 'Not wired up in this demo.', returnTo: SmartToolsSub())))),
        ],
      );
    }

    if (sub is HistorySub) {
      return _screenBody(
        leading: _backButton(() => back(null)),
        title: 'Recent activity',
        children: [
          Row(children: [
            Chip(label: const Text('All Notifications')),
            const SizedBox(width: 8),
            Chip(label: const Text('Consents')),
            const SizedBox(width: 8),
            Chip(label: const Text('Accounts')),
          ]),
          const SizedBox(height: 40),
          Center(child: Text('Sorry, we did not find any details.', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade600, fontSize: 16))),
        ],
      );
    }

    if (sub is FaqSub) {
      const faqs = [
        ['What is an Account Aggregator (AA)?', 'An RBI-regulated entity that moves your consented financial data between institutions — it never sees or stores the data itself.'],
        ['What is a FIP?', 'Financial Information Provider — the institution that actually holds your data (e.g. your bank) and releases it once consent is verified.'],
        ['What is an FIU?', 'Financial Information User — the institution requesting your data for a specific purpose, like this demo PFM app.'],
        ['Can the Account Aggregator view my data as it is shared?', 'No — in the real protocol, the AA only moves encrypted data between FIP and FIU; it cannot read it.'],
        ['Can an entity be just an FIU and not a FIP?', 'Yes — an FIU only consumes data under consent; it doesn\'t have to hold or share any data itself.'],
      ];
      return _screenBody(
        leading: _backButton(() => back(null)),
        title: 'Frequently asked',
        children: [
          for (final f in faqs)
            ExpansionTile(title: Text(f[0]), children: [Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 16), child: Text(f[1]))]),
        ],
      );
    }

    if (sub is DetailSub) {
      return _screenBody(
        leading: _backButton(() => back(sub.returnTo)),
        title: sub.title,
        children: [
          if (sub.body.isNotEmpty) Card(child: Padding(padding: const EdgeInsets.all(14), child: Text(sub.body))),
        ],
      );
    }

    return const SizedBox.shrink();
  }

  Widget _pickRow(String label, bool checked, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              border: Border.all(color: checked ? Theme.of(context).colorScheme.primary : Colors.grey.shade300),
              borderRadius: BorderRadius.circular(12),
              color: checked ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.08) : null,
            ),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text(label),
              if (checked) Icon(Icons.check_circle, color: Theme.of(context).colorScheme.primary),
            ]),
          ),
        ),
      );
}

class _OtpRow extends StatefulWidget {
  final List<TextEditingController> controllers;
  final List<FocusNode> focusNodes;
  final void Function(String) onComplete;
  const _OtpRow({required this.controllers, required this.focusNodes, required this.onComplete});
  @override
  State<_OtpRow> createState() => _OtpRowState();
}

class _OtpRowState extends State<_OtpRow> {
  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          for (var i = 0; i < widget.controllers.length; i++) ...[
            if (i > 0) const SizedBox(width: 12),
            SizedBox(
              width: 52,
              child: TextField(
                controller: widget.controllers[i],
                focusNode: widget.focusNodes[i],
                textAlign: TextAlign.center,
                keyboardType: TextInputType.number,
                maxLength: 1,
                decoration: const InputDecoration(counterText: '', border: OutlineInputBorder()),
                onChanged: (v) {
                  if (v.isNotEmpty && i + 1 < widget.controllers.length) {
                    widget.focusNodes[i + 1].requestFocus();
                  }
                },
              ),
            ),
          ],
        ],
      ),
      const SizedBox(height: 20),
      SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: () {
            final code = widget.controllers.map((c) => c.text).join();
            if (code.length == widget.controllers.length) widget.onComplete(code);
          },
          child: const Padding(padding: EdgeInsets.all(14), child: Text('Continue')),
        ),
      ),
    ]);
  }
}

/// Polls `/v1/fi/insights/:consentId` for the result our TEE-hosted agent
/// posts after fetching and categorising the statement with Kaushal's
/// distilled model — asynchronous, since the agent runs separately from
/// this app, so the first look is usually "not ready yet".
class _InsightsPanel extends StatefulWidget {
  final Api api;
  final String consentId;
  const _InsightsPanel({required this.api, required this.consentId});
  @override
  State<_InsightsPanel> createState() => _InsightsPanelState();
}

class _InsightsPanelState extends State<_InsightsPanel> {
  bool loading = true;
  String? error;
  Map? insights;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { loading = true; error = null; });
    try {
      final body = await widget.api.get('/v1/fi/insights/${widget.consentId}');
      setState(() => insights = body);
    } catch (e) {
      setState(() => error = e is ApiException ? e.message : e.toString());
    } finally {
      setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (loading) {
      return const Padding(padding: EdgeInsets.only(top: 24), child: Center(child: CircularProgressIndicator()));
    }
    if (insights == null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(
          error ?? 'Not ready yet',
          style: TextStyle(color: Colors.grey.shade700),
        ),
        const SizedBox(height: 4),
        Text(
          "Our TEE-hosted agent fetches and categorises the statement separately from this app — run it, then come back and refresh.",
          style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
        ),
        const SizedBox(height: 12),
        OutlinedButton(onPressed: _load, child: const Text('Refresh')),
      ]);
    }

    final txns = (insights!['transactions'] as List).cast<Map>();
    final summary = insights!['summary'] as Map;
    final top = (summary['top_categories'] as List).cast<Map>();

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(
        padding: const EdgeInsets.all(8),
        margin: const EdgeInsets.only(bottom: 12),
        decoration: BoxDecoration(color: const Color(0xFFE8F5E9), borderRadius: BorderRadius.circular(8)),
        child: const Text('Categorised by Kaushal\'s distilled model, running inside a real Confidential VM.', style: TextStyle(fontSize: 12)),
      ),
      Row(children: [
        Expanded(child: _statTile('Income', '₹${summary['total_income']}')),
        const SizedBox(width: 10),
        Expanded(child: _statTile('Spend', '₹${summary['total_spend']}')),
      ]),
      const SizedBox(height: 16),
      const Text('Top categories', style: TextStyle(fontWeight: FontWeight.bold)),
      const SizedBox(height: 8),
      for (final c in top)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text('${c['category']}'),
            Text('₹${c['amount']}'),
          ]),
        ),
      const SizedBox(height: 16),
      Text('All ${txns.length} transactions', style: const TextStyle(fontWeight: FontWeight.bold)),
      const SizedBox(height: 8),
      for (final t in txns)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            SizedBox(width: 90, child: Text('${t['date']}', style: const TextStyle(fontSize: 11))),
            Expanded(child: Text('${t['narration']}', style: const TextStyle(fontSize: 11), maxLines: 1, overflow: TextOverflow.ellipsis)),
            SizedBox(width: 70, child: Text('${t['amount']}', textAlign: TextAlign.right, style: const TextStyle(fontSize: 11))),
          ]),
        ),
    ]);
  }

  Widget _statTile(String label, String value) => Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade300), borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
          const SizedBox(height: 4),
          Text(value, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        ]),
      );
}
