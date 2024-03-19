include .env
include .env.secrets

all: build push deploy ps

build:
	docker build --pull -t honeybee .

start:
	kubectl scale -n honeybee --replicas=1 --all deployment -l=app.kubernetes.io/name=honeybee
	kubectl scale -n honeybee --replicas=2 deployment/worker

stop:
	kubectl scale -n honeybee --replicas=0 --all deployment -l=app.kubernetes.io/name=honeybee

deploy:
ifndef SHA_SHORT
	@echo "SHA_SHORT should be define."
	@exit 1
endif
	mkdir -p ./k8s/output
	kubectl kustomize ./k8s/overlays/production -o ./k8s/output/production.yaml
	envsubst < ./k8s/output/production.yaml > ./k8s/output/production_apply.yaml
	kubectl apply -k ./k8s/output/production_apply.yaml

logs:
	kubectl logs -n honeybee deployment/worker --tail=20000 -f | grep -iE 'required|<!>|unrecognized|unhandled'

schLogs:
	kubectl logs -n honeybee deployment/scheduler -f

showWaitingJobs:
	kubectl logs -n honeybee deployment/scheduler | grep -E 'Waiting=[^0]'

ps:
	kubectl get pods -n honeybee -l app.kubernetes.io/name=honeybee

sh:
	kubectl delete pod -n honeybee honeybee-shell > /dev/null 2>&1 || true
	kubectl run -it -n honeybee honeybee-shell --image=ghcr.io/stu43005/honeybee/honeybee:dev --restart=Never --env="MONGO_URI=${MONGO_URI}" --env="REDIS_URI=${REDIS_URI}" --env="HOLODEX_API_KEY=${HOLODEX_API_KEY}" --command -- sh

logindb:
	kubectl exec -it -n honeybee honeybee-mongodb-0 -- mongosh ${MONGO_URI}
