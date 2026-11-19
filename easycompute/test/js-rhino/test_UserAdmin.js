/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/**
 * Tests for UserAdmin (directory, invite / role / remove, demo role switch, lab scope) and DataLineage.graph.
 * The test runs as the test user, which has no AppUser match, so it starts as the synthetic university admin.
 */
const filename = 'test_UserAdmin';

describe(filename, function () {
  var P = 'test-ua-' + Date.now();

  beforeAll(function () {
    this.ctx = TestApi.createContext(filename);
    TestApi.createEntity(this.ctx, Lab, Lab.make({ id: P + '-lab', name: 'Test Lab', piName: 'Dr. Test' }));
    TestApi.createBatchEntity(this.ctx, LabMember, [
      LabMember.make({ id: P + '-pi', name: 'Test PI', username: P + 'pi', role: 'PI', lab: { id: P + '-lab' } }),
      LabMember.make({ id: P + '-stu', name: 'Test Student', username: P + 'stu', role: 'STUDENT', lab: { id: P + '-lab' } }),
    ]);
    TestApi.waitForSetup(this.ctx);
    TestApi.addExternalTeardownFilter(this.ctx, Filter.eq('lab.id', P + '-lab').toString(), AppUser);
    this.dir = UserAdmin.listUsers(P + '-lab');
  });

  afterAll(function () {
    UserAdmin.setDemoUser(null);
    TestApi.teardown(this.ctx);
  });

  it('creates directory rows for lab members with mapped roles', function () {
    expect(this.dir.counts.total).toBe(2);
    expect(this.dir.counts.byRole.PI).toBe(1);
    expect(this.dir.counts.byRole.STUDENT).toBe(1);
  });

  it('lets the PI invite into their own lab but not see another lab', function () {
    UserAdmin.setDemoUser(P + '-pi');
    expect(UserAdmin.whoAmI().user.role).toBe('PI');
    var u = UserAdmin.inviteUser(P + '@example.edu', 'Invited Person', 'STUDENT', null);
    expect(u.status).toBe('INVITED');
    expect(u.labId).toBe(P + '-lab');
    expect(UserAdmin.removeUser(u.id).status).toBe('DISABLED');
    expect(function () {
      UserAdmin.listUsers('lab-nlp');
    }).toThrow();
  });

  it('does not let a student approve or invite', function () {
    UserAdmin.setDemoUser(P + '-stu');
    expect(function () {
      UserAdmin.inviteUser(P + 'x@example.edu', 'X', 'STUDENT', null);
    }).toThrow();
    expect(function () {
      UserAdmin.approve('RR:does-not-matter', null);
    }).toThrow();
    UserAdmin.setDemoUser(null);
  });

  it('builds a lineage graph whose edges connect existing nodes', function () {
    var g = DataLineage.graph();
    var ids = {};
    g.nodes.forEach(function (n) {
      ids[n.id] = true;
    });
    g.edges.forEach(function (e) {
      expect(ids[e.from] && ids[e.to]).toBe(true);
    });
    expect(g.summary.entities).toBeGreaterThan(10);
  });
});
