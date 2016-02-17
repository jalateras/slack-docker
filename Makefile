DOCKER_BUILD_TAG?=latest
DOCKER_NO_CACHE?=false
DOCKER_IMAGE=pageload/slack-docker:$(DOCKER_BUILD_TAG)

docker-build:
	@docker build --no-cache=$(DOCKER_NO_CACHE) -t $(DOCKER_IMAGE) .

docker-push:
	@docker push $(DOCKER_IMAGE)

.PHONY: docker-build docker-push
