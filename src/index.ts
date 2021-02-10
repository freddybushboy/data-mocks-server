import { pathToRegexp, Key } from 'path-to-regexp';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router, Request } from 'express';
import nunjucks from 'nunjucks';
import path from 'path';
import { transform } from 'server-with-kill';

import { modifyScenarios, resetScenarios } from './apis';
import { getGraphQlMocks, applyGraphQlRoutes } from './graph-ql';
import { getHttpMocks, applyHttpRoutes } from './http';
import { Mock, Options, Scenarios, Default, Context, HttpMock } from './types';
import { getUi, updateUi } from './ui';
import { createHandler } from './create-handler';

export * from './types';
export { run };

function run({
  default: defaultMocks,
  scenarios: scenarioMocks = {},
  options = {},
}: {
  default: Default;
  scenarios?: Scenarios;
  options?: Options;
}) {
  let selectedScenarios: string[] = [];
  let router: Router;
  const {
    port = 3000,
    uiPath = '/',
    modifyScenariosPath = '/modify-scenarios',
    resetScenariosPath = '/reset-scenarios',
    cookieMode = false,
  } = options;

  updateScenarios([]);

  const app = express();
  const scenarioNames = Object.keys(scenarioMocks);
  const groupNames = Object.values(scenarioMocks).reduce<string[]>(
    (result, mock) => {
      if (
        Array.isArray(mock) ||
        mock.group == null ||
        result.includes(mock.group)
      ) {
        return result;
      }

      result.push(mock.group);
      return result;
    },
    [],
  );

  nunjucks.configure(__dirname, {
    autoescape: true,
    express: app,
  });

  app.use(cors());
  app.use(cookieParser());
  app.use(uiPath, express.static(path.join(__dirname, 'assets')));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.text({ type: 'application/graphql' }));

  app.get(uiPath, (req, res, next) =>
    getUi({
      scenarioMocks,
      getScenarios: () => {
        if (cookieMode) {
          return req.cookies.scenarios ? JSON.parse(req.cookies.scenarios) : [];
        }

        return selectedScenarios;
      },
    })(req, res, next),
  );

  app.post(uiPath, (req, res, next) =>
    updateUi({
      groupNames,
      scenarioNames,
      scenarioMocks,
      updateScenarios: updatedScenarios => {
        if (cookieMode) {
          res.cookie('scenarios', JSON.stringify(updatedScenarios), {
            encode: String,
          });

          return;
        }

        return updateScenarios(updatedScenarios);
      },
    })(req, res, next),
  );

  app.put(modifyScenariosPath, (req, res, next) =>
    modifyScenarios({
      scenarioNames,
      scenarioMocks,
      updateScenarios: updatedScenarios => {
        if (cookieMode) {
          res.cookie('scenarios', JSON.stringify(updatedScenarios), {
            encode: String,
          });

          return;
        }

        return updateScenarios(updatedScenarios);
      },
    })(req, res, next),
  );

  app.put(resetScenariosPath, (req, res, next) =>
    resetScenarios({
      updateScenarios: updatedScenarios => {
        if (cookieMode) {
          res.cookie('scenarios', JSON.stringify(updatedScenarios), {
            encode: String,
          });

          return;
        }

        return updateScenarios(updatedScenarios);
      },
    })(req, res, next),
  );

  app.use((req, res, next) => {
    router(req, res, next);
  });

  return transform(
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    }),
  );

  function updateScenarios(updatedScenarios: string[]) {
    selectedScenarios = updatedScenarios;
    console.log('Selected scenarios', selectedScenarios);

    if (cookieMode) {
      const cookieRouter = Router();

      cookieRouter.all('*', (req, res, next) => {
        console.log('req', req.path, req.body, req.query);

        const scenarios: string[] = req.cookies.scenarios
          ? JSON.parse(req.cookies.scenarios)
          : [];

        // TODO: GraphQL implementation: graphQlMocks
        const { httpMocks, initialContext } = getMocksAndInitialContext({
          defaultMocks,
          scenarioMocks,
          scenarios,
        });

        let context: Record<string, any> = req.cookies.context
          ? JSON.parse(req.cookies.context)
          : initialContext;

        const { httpMock, params } = getHttpMockAndParams(req, httpMocks);

        if (!httpMock) {
          // Default 404 from express
          next();

          return;
        }

        // Using router.all() so need to create params manually
        req.params = params;

        const handler = createHandler({
          ...httpMock,
          getContext: () => context,
          updateContext: localUpdateContext,
        });

        handler(req, res);

        function localUpdateContext(
          partialContext: Context | ((context: Context) => Context),
        ) {
          context = updateContext(context, partialContext);

          res.cookie('context', JSON.stringify(context), {
            encode: String,
          });

          return context;
        }
      });

      router = cookieRouter;
    } else {
      router = createRouter({
        defaultMocks,
        scenarioMocks,
        scenarios: selectedScenarios,
      });
    }
  }
}

function createRouter({
  defaultMocks,
  scenarioMocks,
  scenarios,
}: {
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  scenarios: string[];
}) {
  const { httpMocks, graphQlMocks, initialContext } = getMocksAndInitialContext(
    {
      defaultMocks,
      scenarioMocks,
      scenarios,
    },
  );

  let context = initialContext;

  const router = Router();

  applyHttpRoutes({
    router,
    httpMocks,
    getContext,
    updateContext: localUpdateContext,
  });
  applyGraphQlRoutes({
    router,
    graphQlMocks,
    getContext,
    updateContext: localUpdateContext,
  });

  return router;

  function localUpdateContext(
    partialContext: Context | ((context: Context) => Context),
  ) {
    context = updateContext(context, partialContext);

    return context;
  }

  function getContext() {
    return context;
  }
}

function updateContext(
  context: Context,
  partialContext: Context | ((context: Context) => Context),
) {
  const newContext = {
    ...context,
    ...(typeof partialContext === 'function'
      ? partialContext(context)
      : partialContext),
  };

  return newContext;
}

function mergeMocks(scenarioMocks: ({ mocks: Mock[] } | Mock[])[]) {
  return scenarioMocks.reduce<Mock[]>(
    (result, scenarioMock) =>
      result.concat(
        Array.isArray(scenarioMock) ? scenarioMock : scenarioMock.mocks,
      ),
    [],
  );
}

function getInitialContext(mocks: ({ context?: Context } | any[])[]) {
  let context: Context = {};
  mocks.forEach(mock => {
    if (!Array.isArray(mock) && mock.context) {
      context = { ...context, ...mock.context };
    }
  });

  return context;
}

function getMocksAndInitialContext({
  defaultMocks,
  scenarioMocks,
  scenarios,
}: {
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  scenarios: string[];
}) {
  const defaultAndScenarioMocks = [defaultMocks].concat(
    scenarios.map(scenario => scenarioMocks[scenario]),
  );

  const mocks = mergeMocks(defaultAndScenarioMocks);
  const httpMocks = getHttpMocks(mocks);
  const graphQlMocks = getGraphQlMocks(mocks);
  const initialContext = getInitialContext(defaultAndScenarioMocks);

  return { httpMocks, graphQlMocks, initialContext };
}

function getHttpMockAndParams(req: Request, httpMocks: HttpMock[]) {
  let params: Record<string, string>;

  const httpMock =
    httpMocks.find(mock => {
      const { match, params: mockParams } = getMatchAndParams(
        req.path,
        mock.url,
      );
      params = mockParams;

      return mock.method === req.method && match;
    }) || null;

  return {
    httpMock,
    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore This will be set by the "Array.find" method
    params,
  };
}

function getMatchAndParams(reqPath: string, mockUrl: string | RegExp) {
  const params: Record<string, string> = {};
  const keys: Key[] = [];
  const regex = pathToRegexp(mockUrl, keys);
  const match = regex.exec(reqPath);

  if (!match) {
    return {
      match: false,
      params,
    };
  }

  for (let i = 1; i < match.length; i++) {
    const key = keys[i - 1];
    const prop = key.name;

    params[prop] = decodeURIComponent(match[i]);
  }

  return {
    match: true,
    params,
  };
}
